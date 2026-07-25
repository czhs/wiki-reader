import type { Database as SqliteDatabase } from 'better-sqlite3';
import { LibraryItemSchema, type LibraryItem } from '@wr/shared-types';
import { toDocumentFileRef, type DocumentsRepository, type ListDocumentsOptions } from './documents.js';
import { toDocumentFile, type DocumentFileRow } from '../mappers.js';

/**
 * The library sidebar projection.
 *
 * One query per document would be N+1; instead the aggregate columns are fetched in
 * batched statements keyed by the page of document ids that was just listed.
 */
export class LibraryRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly documents: DocumentsRepository,
  ) {}

  list(options: ListDocumentsOptions = {}): { items: LibraryItem[]; total: number } {
    const page = this.documents.list(options);
    return { items: page.items.map((document) => this.compose(document.id)).filter(isPresent), total: page.total };
  }

  get(documentId: string): LibraryItem | null {
    return this.compose(documentId);
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
