/**
 * Zotero -> wiki-reader import (criteria M04, T03).
 *
 * Import is *idempotent*. Every Zotero key is resolved through `external_references`
 * before anything is written, so running the import twice updates the same rows instead of
 * creating a second copy of the library. Zotero keys are never used as internal ids.
 *
 * Nothing here writes to the Zotero library. The client is read-only and
 * `~/Zotero/zotero.sqlite` is never opened.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WikiReaderDatabase } from '@wr/database';
import type { Author, DocumentType } from '@wr/shared-types';
import type { ZoteroLocalClient } from './client.js';
import {
  attachmentHasBytes,
  isImportableItem,
  mapFileRole,
  mapItemToDocument,
  resolveAttachmentPath,
} from './mapping.js';
import { isTrashed, type ZoteroItem } from './wire.js';

export const ZOTERO_PROVIDER = 'zotero';

export interface ImportProgress {
  readonly phase: 'collections' | 'items' | 'attachments' | 'done';
  readonly processed: number;
  readonly total: number;
}

export interface ImportSummary {
  itemsSeen: number;
  documentsCreated: number;
  documentsUpdated: number;
  documentsUnchanged: number;
  filesLinked: number;
  filesMissing: number;
  collectionsImported: number;
  tagsImported: number;
  extractionJobsQueued: number;
  durationMs: number;
  warnings: string[];
}

export interface ImportLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

const silentLogger: ImportLogger = { info: () => {}, warn: () => {} };

export interface ZoteroImporterOptions {
  /** Zotero data directory. Defaults to `~/Zotero`. */
  readonly dataDir?: string;
  readonly linkedBaseDir?: string | undefined;
  readonly logger?: ImportLogger;
  readonly onProgress?: (progress: ImportProgress) => void;
  /** Injectable for tests; defaults to real filesystem inspection. */
  readonly probeFile?: FileProbe;
  /** Monotonic millisecond source, injectable so durations are deterministic in tests. */
  readonly nowMs?: () => number;
}

export interface FileFacts {
  readonly byteSize: number;
  readonly contentHash: string;
}

/** Resolves a path to size + content hash, or null when the bytes are not there. */
export type FileProbe = (path: string) => Promise<FileFacts | null>;

export const defaultZoteroDataDir = (): string => join(homedir(), 'Zotero');

/** SHA-256 over a stream: attachments can be hundreds of megabytes. */
export const hashFileOnDisk: FileProbe = async (path: string): Promise<FileFacts | null> => {
  let byteSize: number;
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return null;
    byteSize = stats.size;
  } catch {
    return null;
  }

  return new Promise<FileFacts | null>((resolve) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve({ byteSize, contentHash: hash.digest('hex') }));
  });
};

interface DocumentWrite {
  readonly documentId: string;
  readonly outcome: 'created' | 'updated' | 'unchanged';
}

export class ZoteroImporter {
  private readonly dataDir: string;
  private readonly linkedBaseDir: string | undefined;
  private readonly logger: ImportLogger;
  private readonly onProgress: (progress: ImportProgress) => void;
  private readonly probeFile: FileProbe;
  private readonly nowMs: () => number;

  constructor(
    private readonly client: ZoteroLocalClient,
    private readonly db: WikiReaderDatabase,
    options: ZoteroImporterOptions = {},
  ) {
    this.dataDir = options.dataDir ?? defaultZoteroDataDir();
    this.linkedBaseDir = options.linkedBaseDir;
    this.logger = options.logger ?? silentLogger;
    this.onProgress = options.onProgress ?? ((): void => {});
    this.probeFile = options.probeFile ?? hashFileOnDisk;
    this.nowMs = options.nowMs ?? ((): number => Date.now());
  }

  /**
   * Pull the whole library.
   *
   * `force` re-reads every item even when its Zotero version is unchanged, which is what
   * makes a repair run possible after a mapping bug is fixed.
   */
  async import(options: { force?: boolean } = {}): Promise<ImportSummary> {
    const force = options.force ?? false;
    const startedAt = this.nowMs();
    const summary: ImportSummary = {
      itemsSeen: 0,
      documentsCreated: 0,
      documentsUpdated: 0,
      documentsUnchanged: 0,
      filesLinked: 0,
      filesMissing: 0,
      collectionsImported: 0,
      tagsImported: 0,
      extractionJobsQueued: 0,
      durationMs: 0,
      warnings: [],
    };

    const collectionIdByKey = await this.importCollections(summary);
    const items = (await this.client.listTopItems()).filter(
      (item) => isImportableItem(item) && !isTrashed(item),
    );
    summary.itemsSeen = items.length;
    this.logger.info('zotero.import.started', { items: items.length, force });

    let processed = 0;
    for (const item of items) {
      try {
        await this.importItem(item, collectionIdByKey, force, summary);
      } catch (error) {
        // One malformed item must not abort the whole library import, but it must be
        // reported: a silently skipped document is indistinguishable from a missing one.
        const message = error instanceof Error ? error.message : String(error);
        summary.warnings.push(`item ${item.data.key}: ${message}`);
        this.logger.warn('zotero.import.item_failed', { key: item.data.key, error: message });
      }
      processed += 1;
      this.onProgress({ phase: 'items', processed, total: items.length });
    }

    summary.durationMs = Math.max(0, this.nowMs() - startedAt);
    this.onProgress({ phase: 'done', processed, total: items.length });
    this.logger.info('zotero.import.finished', {
      created: summary.documentsCreated,
      updated: summary.documentsUpdated,
      unchanged: summary.documentsUnchanged,
      filesLinked: summary.filesLinked,
      filesMissing: summary.filesMissing,
      durationMs: summary.durationMs,
    });
    return summary;
  }

  /** Collections first: items reference them by key. */
  private async importCollections(summary: ImportSummary): Promise<Map<string, string>> {
    const collections = await this.client.listCollections();
    const idByKey = new Map<string, string>();

    // Two passes: a child collection can appear before its parent in the response.
    for (const collection of collections) {
      const existingId = this.db.externalReferences.resolveEntityId(
        ZOTERO_PROVIDER,
        'collection',
        collection.data.key,
      );
      const record =
        existingId === null
          ? this.db.collections.create({ name: collection.data.name, parentId: null })
          : this.db.collections.update(existingId, {
              name: collection.data.name,
              parentId: null,
            });
      this.db.externalReferences.upsert({
        entityType: 'collection',
        entityId: record.id,
        provider: ZOTERO_PROVIDER,
        externalKey: collection.data.key,
        externalVersion: collection.data.version,
      });
      idByKey.set(collection.data.key, record.id);
      summary.collectionsImported += 1;
    }

    for (const collection of collections) {
      const parentKey = collection.data.parentCollection;
      if (parentKey === undefined || parentKey === false) continue;
      const childId = idByKey.get(collection.data.key);
      const parentId = idByKey.get(parentKey);
      if (childId === undefined || parentId === undefined) continue;
      this.db.collections.update(childId, { name: collection.data.name, parentId });
    }

    this.onProgress({ phase: 'collections', processed: collections.length, total: collections.length });
    return idByKey;
  }

  private async importItem(
    item: ZoteroItem,
    collectionIdByKey: Map<string, string>,
    force: boolean,
    summary: ImportSummary,
  ): Promise<void> {
    const children = await this.client.listChildren(item.data.key);
    const attachments = children.filter((child) => child.data.itemType === 'attachment');
    const mapped = mapItemToDocument(item, attachments);

    const write = this.writeDocument(item, mapped.title, mapped.docType, mapped, force);
    if (write.outcome === 'unchanged') {
      summary.documentsUnchanged += 1;
      return;
    }
    if (write.outcome === 'created') summary.documentsCreated += 1;
    else summary.documentsUpdated += 1;

    const tags = this.db.tags.setDocumentTags(write.documentId, mapped.tags);
    summary.tagsImported += tags.length;

    const collectionIds = mapped.collectionKeys
      .map((key) => collectionIdByKey.get(key))
      .filter((id): id is string => id !== undefined);
    this.db.collections.setDocumentCollections(write.documentId, collectionIds);

    await this.importAttachments(write.documentId, attachments, summary);
  }

  /**
   * Write the `documents` row and its provenance in one transaction.
   *
   * The external reference and the document must appear together or not at all: a
   * document without its reference would be re-imported as a duplicate on the next run.
   */
  private writeDocument(
    item: ZoteroItem,
    title: string,
    docType: DocumentType,
    mapped: { authors: Author[]; abstract: string | null; publishedDate: string | null },
    force: boolean,
  ): DocumentWrite {
    const reference = this.db.externalReferences.find(ZOTERO_PROVIDER, 'document', item.data.key);

    if (reference !== null && !force && reference.externalVersion === item.data.version) {
      // Same Zotero version as last time: nothing upstream changed.
      const existing = this.db.documents.getById(reference.entityId);
      if (existing !== null) return { documentId: reference.entityId, outcome: 'unchanged' };
      // The reference outlived its document (manual deletion). Fall through and recreate.
    }

    return this.db.transaction((): DocumentWrite => {
      const existing =
        reference === null ? null : this.db.documents.getById(reference.entityId);

      const document =
        existing === null
          ? this.db.documents.create({
              title,
              docType,
              authors: mapped.authors,
              abstract: mapped.abstract,
              publishedDate: mapped.publishedDate,
              source: ZOTERO_PROVIDER,
            })
          : this.db.documents.update(existing.id, {
              title,
              docType,
              authors: mapped.authors,
              abstract: mapped.abstract,
              publishedDate: mapped.publishedDate,
            });

      this.db.externalReferences.upsert({
        entityType: 'document',
        entityId: document.id,
        provider: ZOTERO_PROVIDER,
        externalKey: item.data.key,
        externalVersion: item.data.version,
      });

      return { documentId: document.id, outcome: existing === null ? 'created' : 'updated' };
    });
  }

  private async importAttachments(
    documentId: string,
    attachments: readonly ZoteroItem[],
    summary: ImportSummary,
  ): Promise<void> {
    const withBytes = attachments.filter(attachmentHasBytes);
    const hasPdfSibling = withBytes.some((a) => a.data.contentType === 'application/pdf');
    let seenPdf = false;
    let queuedExtraction = false;

    for (const attachment of withBytes) {
      const path = resolveAttachmentPath(attachment, {
        dataDir: this.dataDir,
        linkedBaseDir: this.linkedBaseDir,
      });
      if (path === null) {
        summary.filesMissing += 1;
        summary.warnings.push(`attachment ${attachment.data.key}: no resolvable path`);
        this.logger.warn('zotero.import.attachment_unresolved', { key: attachment.data.key });
        continue;
      }

      const facts = await this.probeFile(path);
      if (facts === null) {
        // Zotero knows about the attachment but the bytes are absent — commonly an
        // unsynced file. Recorded, never silently dropped.
        summary.filesMissing += 1;
        summary.warnings.push(`attachment ${attachment.data.key}: file missing on disk`);
        this.logger.warn('zotero.import.file_missing', { key: attachment.data.key, path });
        continue;
      }

      const isPdf = attachment.data.contentType === 'application/pdf';
      const isFirstPdf = isPdf && !seenPdf;
      if (isFirstPdf) seenPdf = true;

      const { file } = this.db.files.upsertByPath({
        documentId,
        path,
        mimeType: attachment.data.contentType ?? 'application/octet-stream',
        byteSize: facts.byteSize,
        contentHash: facts.contentHash,
        role: mapFileRole(attachment, { hasPdfSibling, isFirstPdf }),
      });
      this.db.externalReferences.upsert({
        entityType: 'documentFile',
        entityId: file.id,
        provider: ZOTERO_PROVIDER,
        externalKey: attachment.data.key,
        externalVersion: attachment.data.version,
      });
      summary.filesLinked += 1;

      if (isPdf && !queuedExtraction) {
        const { created } = this.db.jobs.enqueue(documentId, 'extract-text');
        if (created) summary.extractionJobsQueued += 1;
        queuedExtraction = true;
      }
    }
  }
}
