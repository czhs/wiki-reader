import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { Clock } from '../clock.js';

/**
 * Pages the corpus links to but does not contain.
 *
 * A `[[slug]]` with nothing behind it is how a wiki gets written — you link the page you mean
 * to write next. Storing them makes that backlog visible (and graphable) without turning it
 * into an error state: rows for a document are replaced wholesale each time it is indexed, so
 * a link the author deleted stops being wanted, and a page that is finally written disappears
 * from the list the next time anything referencing it is indexed.
 */

export interface WantedPageRow {
  document_id: string;
  slug: string;
  title: string;
  count: number;
  updated_at: string;
}

export interface WantedPageReference {
  readonly documentId: string;
  readonly slug: string;
  readonly title: string;
  readonly count: number;
}

/** A wanted page aggregated across every document that asks for it. */
export interface WantedPage {
  readonly slug: string;
  readonly title: string;
  readonly count: number;
  readonly referencedBy: readonly string[];
}

export class WantedPagesRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  /** Replace one document's wanted pages. */
  replaceForDocument(
    documentId: string,
    pages: ReadonlyArray<{ slug: string; title: string; count: number }>,
  ): number {
    const now = this.clock.now();
    const remove = this.db.prepare('DELETE FROM wanted_pages WHERE document_id = ?');
    const insert = this.db.prepare(
      `INSERT INTO wanted_pages (document_id, slug, title, count, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (document_id, slug) DO UPDATE
         SET title = excluded.title, count = excluded.count, updated_at = excluded.updated_at`,
    );
    const run = this.db.transaction((): number => {
      remove.run(documentId);
      for (const page of pages) {
        insert.run(documentId, page.slug, page.title, page.count, now);
      }
      return pages.length;
    });
    return run();
  }

  /** Every wanted page, aggregated, most-wanted first. */
  list(limit = 500): WantedPage[] {
    const rows = this.db
      .prepare(
        `SELECT slug,
                MIN(title)      AS title,
                SUM(count)      AS count,
                GROUP_CONCAT(document_id, char(31)) AS referenced_by
           FROM wanted_pages
          GROUP BY slug
          ORDER BY count DESC, slug
          LIMIT ?`,
      )
      .all(limit) as Array<{
      slug: string;
      title: string;
      count: number;
      referenced_by: string | null;
    }>;
    return rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      count: row.count,
      // `char(31)` (unit separator) rather than a comma: a document id never contains one,
      // and GROUP_CONCAT offers no escaping.
      referencedBy: row.referenced_by === null ? [] : row.referenced_by.split(''),
    }));
  }

  /** Which documents want one page. */
  referencesTo(slug: string): WantedPageReference[] {
    const rows = this.db
      .prepare(
        `SELECT document_id, slug, title, count FROM wanted_pages
          WHERE slug = ? ORDER BY document_id`,
      )
      .all(slug) as WantedPageRow[];
    return rows.map((row) => ({
      documentId: row.document_id,
      slug: row.slug,
      title: row.title,
      count: row.count,
    }));
  }
}
