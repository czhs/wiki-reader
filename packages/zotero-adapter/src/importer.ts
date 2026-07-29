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
import { ZoteroError, type ZoteroLocalClient } from './client.js';
import {
  attachmentHasBytes,
  isImportableItem,
  mapFileRole,
  mapItemToDocument,
  resolveAttachmentPath,
} from './mapping.js';
import { isTrashed, type ZoteroCollection, type ZoteroItem } from './wire.js';

export const ZOTERO_PROVIDER = 'zotero';

/**
 * The collection keys an import scoped to `name` covers: the named collection and everything
 * filed beneath it.
 *
 * Subcollections are included because a Zotero collection is how a project is organised, not
 * how it is partitioned — "Past Projects" holding nothing directly and everything through its
 * children is the normal shape, and scoping to it would otherwise import nothing.
 *
 * The name is matched case-insensitively on trimmed text, since it is typed by a person.
 * Ambiguity is reported rather than guessed: two collections can share a name under different
 * parents, and silently picking one would import the wrong project.
 */
export function collectionScope(
  collections: readonly ZoteroCollection[],
  name: string,
): Set<string> {
  const wanted = name.trim().toLowerCase();
  const matches = collections.filter((c) => c.data.name.trim().toLowerCase() === wanted);

  if (matches.length === 0) {
    throw new ZoteroError(
      'NOT_FOUND',
      `Zotero has no collection named “${name}”.`,
      'Check the collection name in Zotero, then import again.',
    );
  }
  if (matches.length > 1) {
    throw new ZoteroError(
      'CONFLICT',
      `Zotero has ${String(matches.length)} collections named “${name}”.`,
      'Rename one of them in Zotero so the import can tell them apart.',
    );
  }

  const root = matches[0];
  if (root === undefined) throw new Error('unreachable: matched collection vanished');

  const keys = new Set<string>([root.data.key]);
  // Breadth-first over the parent links, which is the only direction the wire format gives.
  let grew = true;
  while (grew) {
    grew = false;
    for (const collection of collections) {
      const parent = collection.data.parentCollection;
      if (parent === undefined || parent === false) continue;
      if (!keys.has(parent) || keys.has(collection.data.key)) continue;
      keys.add(collection.data.key);
      grew = true;
    }
  }
  return keys;
}

/**
 * The collection names an import is scoped to, in the order they were given, without repeats.
 *
 * Blank entries are dropped rather than passed on: a remembered pick list that has picked up
 * an empty string would otherwise fail the whole import with "Zotero has no collection named
 * ''", which is true and useless.
 */
function scopedNames(options: {
  collection?: string;
  collections?: readonly string[];
}): readonly string[] {
  const given = options.collections ?? (options.collection === undefined ? [] : [options.collection]);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of given) {
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (trimmed === '' || seen.has(key)) continue;
    seen.add(key);
    names.push(trimmed);
  }
  return names;
}

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
  /**
   * Items a routine import passed over because the researcher took them out of the library
   * (criterion B01).
   *
   * Counted rather than silent: an import that quietly declines to import something the
   * library is asking for looks exactly like an import that lost it.
   */
  documentsRemoved: number;
  /**
   * Removed documents this import brought back, because it was scoped to a collection
   * holding them (criterion B01).
   *
   * A removal means "not now", not "never again": naming the collection is how the
   * researcher asks for it back, and this is what says how many came.
   */
  documentsRestored: number;
  filesLinked: number;
  filesMissing: number;
  collectionsImported: number;
  tagsImported: number;
  extractionJobsQueued: number;
  durationMs: number;
  warnings: string[];
  /**
   * The collections the import was scoped to, comma-separated, or null for the whole library.
   * A display string: it is what the status bar says the import covered.
   */
  collectionScope: string | null;
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
  readonly outcome: 'created' | 'updated' | 'unchanged' | 'removed' | 'restored';
}

/** How this run treats what it finds: re-read everything, and was a collection named. */
interface ImportMode {
  readonly force: boolean;
  /**
   * True when the researcher named a collection *in this action*, which is a request for what
   * is in it. Deliberately not "the run was filtered": the standing import scope filters the
   * routine sync too, and a filter someone set last week is not a request made today.
   */
  readonly requested: boolean;
}

/**
 * Where a run's scope came from.
 *
 * `named` is the researcher pointing at a collection now — the Import button on a collection
 * row. `remembered` is the standing set of picks, which narrows what the routine sync reads
 * and says nothing about any particular paper.
 */
export type ScopeOrigin = 'named' | 'remembered';

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
   * Pull the library, or the named collections of it.
   *
   * `collections` scopes the import the way a researcher works: to the collections this
   * project lives in, their subcollections included, and nothing else. Scoping is additive —
   * importing another collection later leaves the first one's documents alone, because
   * nothing here deletes. That is what makes "the collections I'm working from" a usable unit
   * rather than a filter you have to re-apply forever.
   *
   * Several names are one import rather than one import each: the item list is fetched once
   * and filtered against the union of their keys, so a paper filed in two picked collections
   * is seen once and the totals mean what they say.
   *
   * `collection` is the single-name form, kept because a scoped import is usually a scoped
   * import to one place.
   *
   * Naming a collection is also how a removed document comes back (criterion B01). A removal
   * says "not now", so the routine sync leaves removals alone, and asking for a *particular*
   * collection is the researcher saying they want what is in it. That asymmetry is the whole
   * of the rule: no blacklist to maintain, and no sync that quietly undoes a morning's
   * curation.
   *
   * `scopeOrigin` is what keeps that asymmetry true once the researcher has ticked a standing
   * set of collections. Those picks scope the routine sync as well, so "this run was filtered"
   * and "the researcher asked for this" stopped being the same fact: a plain Import would
   * arrive here scoped, and lift every removal inside the picks. The caller says which it is;
   * the default is `named`, because every caller that passes a collection is pointing at one.
   *
   * `force` re-reads every item even when its Zotero version is unchanged, which is what
   * makes a repair run possible after a mapping bug is fixed.
   */
  async import(
    options: {
      force?: boolean;
      collection?: string;
      collections?: readonly string[];
      scopeOrigin?: ScopeOrigin;
    } = {},
  ): Promise<ImportSummary> {
    const force = options.force ?? false;
    const scopeOrigin = options.scopeOrigin ?? 'named';
    const scopeNames = scopedNames(options);
    const scopeName = scopeNames.length === 0 ? null : scopeNames.join(', ');
    const startedAt = this.nowMs();
    const summary: ImportSummary = {
      itemsSeen: 0,
      documentsCreated: 0,
      documentsUpdated: 0,
      documentsUnchanged: 0,
      documentsRemoved: 0,
      documentsRestored: 0,
      filesLinked: 0,
      filesMissing: 0,
      collectionsImported: 0,
      tagsImported: 0,
      extractionJobsQueued: 0,
      durationMs: 0,
      warnings: [],
      collectionScope: scopeName,
    };

    // The collection list is fetched once and used twice: to mirror the tree, and — when the
    // import is scoped — to turn the name the user gave into the set of keys in scope. It is
    // resolved *before* anything is written, so an unknown name imports nothing at all.
    const collections = await this.client.listCollections();
    const scopeKeys =
      scopeNames.length === 0
        ? null
        : new Set(scopeNames.flatMap((name) => [...collectionScope(collections, name)]));

    const collectionIdByKey = await this.importCollections(collections, summary);
    const items = (await this.client.listTopItems()).filter(
      (item) =>
        isImportableItem(item) &&
        !isTrashed(item) &&
        (scopeKeys === null || (item.data.collections ?? []).some((key) => scopeKeys.has(key))),
    );
    summary.itemsSeen = items.length;
    this.logger.info('zotero.import.started', { items: items.length, force });

    let processed = 0;
    for (const item of items) {
      try {
        // Every item that survives the filter above is in one of the scoped collections — but
        // that only means it was *asked for* when the scope is one the researcher named now.
        // A standing pick filters the routine sync too, and must not answer for any paper.
        await this.importItem(
          item,
          collectionIdByKey,
          { force, requested: scopeKeys !== null && scopeOrigin === 'named' },
          summary,
        );
      } catch (error) {
        // One malformed item must not abort the whole library import, but it must be
        // reported: a silently skipped document is indistinguishable from a missing one.
        //
        // The warning names the item and nothing else. `warnings` is ordinary response data
        // returned to the renderer, so it routes around `toIpcError`, which exists precisely
        // because a thrown message may name a filesystem path or a SQL fragment and the
        // renderer is not entitled to either. The detail goes to the log, where the other
        // two warning sites already send it.
        const message = error instanceof Error ? error.message : String(error);
        summary.warnings.push(`item ${item.data.key}: import failed`);
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
      restored: summary.documentsRestored,
      filesLinked: summary.filesLinked,
      filesMissing: summary.filesMissing,
      durationMs: summary.durationMs,
    });
    return summary;
  }

  /**
   * Collections first: items reference them by key.
   *
   * The whole tree is mirrored even for a scoped import. Collections are names and parents,
   * not content, and a library whose shape is half-present would make the sidebar lie about
   * where a scoped document sits.
   */
  private async importCollections(
    collections: readonly ZoteroCollection[],
    summary: ImportSummary,
  ): Promise<Map<string, string>> {
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
    mode: ImportMode,
    summary: ImportSummary,
  ): Promise<void> {
    const children = await this.client.listChildren(item.data.key);
    const attachments = children.filter((child) => child.data.itemType === 'attachment');
    const mapped = mapItemToDocument(item, attachments);

    const write = this.writeDocument(item, mapped.title, mapped.docType, mapped, mode);
    // Removed on purpose, and this run did not ask for its collection by name. Returning here
    // rather than after the write is what makes the removal hold for everything hanging off
    // the item too: no tags, no collection membership, no attachment rows, no extraction job
    // for a document the library does not have. An import that skipped only the `documents`
    // row would re-link the PDF to a document nobody can see, and queue work to extract it.
    if (write.outcome === 'removed') {
      summary.documentsRemoved += 1;
      return;
    }
    if (write.outcome === 'unchanged') {
      summary.documentsUnchanged += 1;
      return;
    }
    if (write.outcome === 'created') summary.documentsCreated += 1;
    else if (write.outcome === 'restored') {
      summary.documentsRestored += 1;
      // The chunks survived the removal, so the text is still there to index; the search
      // entries that pointed at it did not, and are rebuilt rather than resurrected.
      this.db.jobs.enqueue(write.documentId, 'index-fts');
    } else summary.documentsUpdated += 1;

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
    mode: ImportMode,
  ): DocumentWrite {
    const { force, requested } = mode;
    const reference = this.db.externalReferences.find(ZOTERO_PROVIDER, 'document', item.data.key);

    // Taken out of the library on purpose. Checked before everything, including `force`: a
    // repair run re-reads what the library holds, and this is an item the library was told to
    // stop holding, so a routine run passes over it. A run the researcher aimed at a named
    // collection is the opposite request — they named the shelf this is on and asked for it —
    // so the removal is lifted and the item is written as if it had never left (criterion B01).
    let restoring = false;
    if (reference !== null && reference.removedAt !== null) {
      if (!requested) return { documentId: reference.entityId, outcome: 'removed' };
      this.db.library.restore(reference.entityId);
      restoring = true;
    }

    // A restore never takes the unchanged short-circuit: the Zotero version says nothing
    // changed *upstream*, and what changed is here — the document was hidden, its search
    // entries dropped and its files' provenance tombstoned, and all of it has to be rewritten.
    if (reference !== null && !restoring && !force && reference.externalVersion === item.data.version) {
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

      return {
        documentId: document.id,
        outcome: restoring ? 'restored' : existing === null ? 'created' : 'updated',
      };
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
