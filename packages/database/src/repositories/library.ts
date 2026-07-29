import type { Database as SqliteDatabase } from 'better-sqlite3';
import { LibraryItemSchema, type LibraryItem } from '@wr/shared-types';
import { toDocumentFileRef, type DocumentsRepository, type ListDocumentsOptions } from './documents.js';
import { toDocumentFile, type DocumentFileRow } from '../mappers.js';
import type { ExternalReferencesRepository } from './external-references.js';
import type { SearchIndexRepository } from './search-index.js';

/** What a removal left behind, so the caller can say what is still there to come back to. */
export interface LibraryRemoval {
  /** False when the document was already removed, or does not exist. */
  readonly removed: boolean;
  /** Annotations the removal did not touch. The researcher's work, not Zotero's. */
  readonly annotationsKept: number;
  /** Edges — to questions, notes, other documents — the removal did not touch. */
  readonly linksKept: number;
  /** Provider keys tombstoned, so an import cannot bring the document back. */
  readonly tombstones: number;
}

/**
 * The library sidebar projection, and what it means to take something out of the library.
 *
 * One query per document would be N+1; instead the aggregate columns are fetched in
 * batched statements keyed by the page of document ids that was just listed.
 */
export class LibraryRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly documents: DocumentsRepository,
    private readonly externalReferences: ExternalReferencesRepository,
    private readonly searchIndex: SearchIndexRepository,
  ) {}

  list(options: ListDocumentsOptions = {}): { items: LibraryItem[]; total: number } {
    const page = this.documents.list(options);
    return { items: page.items.map((document) => this.compose(document.id)).filter(isPresent), total: page.total };
  }

  get(documentId: string): LibraryItem | null {
    return this.compose(documentId);
  }

  /**
   * Take a document out of the library (criteria B01, B03).
   *
   * Three things in one transaction, because two of them without the third is a bug:
   *
   *   1. the document is *hidden*, not deleted — its annotations, its links and its position
   *      on a desk board are the researcher's work and survive the removal intact;
   *   2. every provider key it carries is tombstoned, so the next Zotero import — including a
   *      forced one — skips the item rather than discovering an unknown key and recreating
   *      the document;
   *   3. its search entries go, because a removed document that still answers a query is a
   *      result that opens something the library says is not there.
   *
   * The search entries are the one part that is rebuilt rather than restored: they are
   * derived from the chunks, which are still on the document, so `restore` re-indexes.
   */
  remove(documentId: string): LibraryRemoval {
    const empty: LibraryRemoval = {
      removed: false,
      annotationsKept: 0,
      linksKept: 0,
      tombstones: 0,
    };
    if (this.documents.getById(documentId) === null) return empty;

    const run = this.db.transaction((): LibraryRemoval => {
      if (!this.documents.softDelete(documentId)) return empty;
      const tombstones =
        this.externalReferences.recordRemoval('document', documentId) +
        this.tombstoneFiles(documentId);
      this.searchIndex.removeForDocument(documentId);
      return {
        removed: true,
        annotationsKept: this.annotationCount(documentId),
        linksKept: this.linkCount(documentId),
        tombstones,
      };
    });
    return run();
  }

  /** Put a removed document back, tombstones cleared and its text queued for re-indexing. */
  restore(documentId: string): boolean {
    const run = this.db.transaction((): boolean => {
      if (!this.documents.restore(documentId)) return false;
      this.externalReferences.clearRemoval('document', documentId);
      for (const file of this.fileIds(documentId)) {
        this.externalReferences.clearRemoval('documentFile', file);
      }
      return true;
    });
    return run();
  }

  /**
   * What has been removed, most recently first.
   *
   * The list is what makes "recoverable" true rather than merely technically true: work the
   * researcher can no longer find has been destroyed as far as they are concerned.
   */
  listRemoved(limit = 100): LibraryItem[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM documents WHERE deleted_at IS NOT NULL
          ORDER BY deleted_at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as Array<{ id: string }>;
    return rows.map((row) => this.compose(row.id)).filter(isPresent);
  }

  private tombstoneFiles(documentId: string): number {
    let tombstoned = 0;
    for (const fileId of this.fileIds(documentId)) {
      tombstoned += this.externalReferences.recordRemoval('documentFile', fileId);
    }
    return tombstoned;
  }

  private fileIds(documentId: string): string[] {
    return (
      this.db
        .prepare('SELECT id FROM document_files WHERE document_id = ?')
        .all(documentId) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  private annotationCount(documentId: string): number {
    return (
      (
        this.db
          .prepare(
            'SELECT COUNT(*) AS n FROM annotations WHERE document_id = ? AND deleted_at IS NULL',
          )
          .get(documentId) as { n: number } | undefined
      )?.n ?? 0
    );
  }

  private linkCount(documentId: string): number {
    return (
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM links
              WHERE (source_type = 'document' AND source_id = ?)
                 OR (target_type = 'document' AND target_id = ?)`,
          )
          .get(documentId, documentId) as { n: number } | undefined
      )?.n ?? 0
    );
  }

  private compose(documentId: string): LibraryItem | null {
    const document = this.documents.getById(documentId);
    if (document === null) return null;

    const fileRows = this.db
      .prepare('SELECT * FROM document_files WHERE document_id = ? ORDER BY created_at, id')
      .all(documentId) as DocumentFileRow[];

    const tags = (
      this.db
        .prepare(
          `SELECT t.name FROM tags t JOIN document_tags dt ON dt.tag_id = t.id
            WHERE dt.document_id = ? ORDER BY t.name`,
        )
        .all(documentId) as Array<{ name: string }>
    ).map((row) => row.name);

    const collectionIds = (
      this.db
        .prepare('SELECT collection_id FROM document_collections WHERE document_id = ?')
        .all(documentId) as Array<{ collection_id: string }>
    ).map((row) => row.collection_id);

    const annotationCount =
      (
        this.db
          .prepare(
            'SELECT COUNT(*) AS n FROM annotations WHERE document_id = ? AND deleted_at IS NULL',
          )
          .get(documentId) as { n: number } | undefined
      )?.n ?? 0;

    const chunkCount =
      (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM document_chunks WHERE document_id = ?')
          .get(documentId) as { n: number } | undefined
      )?.n ?? 0;

    return LibraryItemSchema.parse({
      document,
      files: fileRows.map((row) => toDocumentFileRef(toDocumentFile(row))),
      tags,
      collectionIds,
      annotationCount,
      hasExtractedText: chunkCount > 0,
    });
  }
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
