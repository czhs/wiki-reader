import type { DocumentLocation } from '@wr/shared-types';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { Clock } from '../clock.js';
import { serializeLocation } from '../mappers.js';

export type SearchEntityType = 'document' | 'chunk' | 'annotation' | 'note';

export interface SearchEntryInput {
  readonly entityType: SearchEntityType;
  readonly entityId: string;
  readonly documentId?: string | null | undefined;
  readonly location?: DocumentLocation | null | undefined;
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  /** Authors, tags, collection names — searchable but ranked separately from the body. */
  readonly meta?: string | undefined;
}

/**
 * Write side of the full-text index.
 *
 * Nothing here parses queries; that lives in @wr/search. This repository only maintains
 * the projection table, and the FTS5 triggers keep the index in step with it.
 */
export class SearchIndexRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  upsert(entry: SearchEntryInput): void {
    this.db
      .prepare(
        `INSERT INTO search_entries
           (entity_type, entity_id, document_id, location_json, title, body, meta, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET
           document_id   = excluded.document_id,
           location_json = excluded.location_json,
           title         = excluded.title,
           body          = excluded.body,
           meta          = excluded.meta,
           updated_at    = excluded.updated_at`,
      )
      .run(
        entry.entityType,
        entry.entityId,
        entry.documentId ?? null,
        serializeLocation(entry.location),
        entry.title ?? '',
        entry.body ?? '',
        entry.meta ?? '',
        this.clock.now(),
      );
  }

  upsertMany(entries: readonly SearchEntryInput[]): number {
    const run = this.db.transaction((items: readonly SearchEntryInput[]) => {
      for (const item of items) this.upsert(item);
    });
    run(entries);
    return entries.length;
  }

  remove(entityType: SearchEntityType, entityId: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM search_entries WHERE entity_type = ? AND entity_id = ?')
        .run(entityType, entityId).changes > 0
    );
  }

  /** Drop every entry belonging to a document, including its chunks and annotations. */
  removeForDocument(documentId: string): number {
    return this.db
      .prepare(
        `DELETE FROM search_entries
          WHERE document_id = ? OR (entity_type = 'document' AND entity_id = ?)`,
      )
      .run(documentId, documentId).changes;
  }

  /** Drop chunk entries for a document before re-indexing a new revision. */
  removeChunksForDocument(documentId: string): number {
    return this.db
      .prepare("DELETE FROM search_entries WHERE entity_type = 'chunk' AND document_id = ?")
      .run(documentId).changes;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM search_entries').get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  countForDocument(documentId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM search_entries WHERE document_id = ?')
      .get(documentId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Documents with at least one indexed chunk. Drives the "indexed / total" status. */
  indexedDocumentCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(DISTINCT document_id) AS n FROM search_entries WHERE entity_type = 'chunk'",
      )
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Rebuild the FTS index from the projection table. Used after a bulk repair. */
  rebuild(): void {
    this.db.exec("INSERT INTO search_fts(search_fts) VALUES('rebuild')");
  }
}
