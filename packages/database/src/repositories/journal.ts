import type { Database as SqliteDatabase } from 'better-sqlite3';
import { localDay } from '@wr/document-model';
import type { JournalEntry } from '@wr/shared-types';
import type { Clock } from '../clock.js';
import { toJournalEntry, type JournalEntryRow } from '../mappers.js';

export interface JournalRangeOptions {
  /** Inclusive ISO date bounds. Omitted means unbounded on that side. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/**
 * A notebook's log: one markdown entry per day, per notebook (criterion P02).
 *
 * Two rules the rest of the app depends on:
 *
 * - **A day belongs to a notebook.** Every method here takes the notebook whose log it is.
 *   There is no way through this repository to read or write "the journal" — `listAll` exists
 *   for the exporters that walk everything, and it says which notebook each day came from.
 * - **`write` with blank markdown deletes the day** rather than storing an empty entry. An
 *   unlogged day and a day logged with nothing are the same fact, and a calendar that told
 *   them apart would be showing a difference that does not exist. The schema refuses the empty
 *   string too, so no other writer can reintroduce it.
 */
export class JournalRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  get(notebookId: string, date: string): JournalEntry | null {
    const row = this.db
      .prepare('SELECT * FROM journal_entries WHERE notebook_id = ? AND date = ?')
      .get(notebookId, date) as JournalEntryRow | undefined;
    return row === undefined ? null : toJournalEntry(row);
  }

  /** Write the day, or delete it when what was typed is blank. Returns the entry, or null. */
  write(notebookId: string, date: string, markdown: string): JournalEntry | null {
    if (markdown.trim() === '') {
      this.delete(notebookId, date);
      return null;
    }
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO journal_entries (notebook_id, date, markdown, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(notebook_id, date) DO UPDATE SET markdown = excluded.markdown,
                                                      updated_at = excluded.updated_at`,
      )
      .run(notebookId, date, markdown, now, now);
    const entry = this.get(notebookId, date);
    if (entry === null) throw new Error('journal.write: row vanished after insert');
    return entry;
  }

  delete(notebookId: string, date: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM journal_entries WHERE notebook_id = ? AND date = ?')
        .run(notebookId, date).changes > 0
    );
  }

  /** One notebook's entries in a date range, oldest first. */
  list(notebookId: string, options: JournalRangeOptions = {}): JournalEntry[] {
    const clauses: string[] = ['notebook_id = ?'];
    const params: string[] = [notebookId];
    if (options.from !== undefined) {
      clauses.push('date >= ?');
      params.push(options.from);
    }
    if (options.to !== undefined) {
      clauses.push('date <= ?');
      params.push(options.to);
    }
    const rows = this.db
      .prepare(`SELECT * FROM journal_entries WHERE ${clauses.join(' AND ')} ORDER BY date`)
      .all(...params) as JournalEntryRow[];
    return rows.map(toJournalEntry);
  }

  /**
   * Every entry in the library, whichever notebook it belongs to.
   *
   * For the exporters — the librarian's read-only view, the disclosure that counts what would
   * be sent. Not for the journal page: a page that showed every notebook's days at once is
   * exactly the global stream `P02` retired.
   */
  listAll(): JournalEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM journal_entries ORDER BY notebook_id, date')
      .all() as JournalEntryRow[];
    return rows.map(toJournalEntry);
  }

  /**
   * Which days of a notebook have an entry.
   *
   * The calendar needs the dates and nothing else — a year of markdown crossing the IPC
   * boundary to decide which bubbles are filled in would be the wrong query.
   */
  loggedDates(notebookId: string, options: JournalRangeOptions = {}): string[] {
    return this.list(notebookId, options).map((entry) => entry.date);
  }

  /** The earliest day this notebook has an entry on. Null when nobody has written in it. */
  firstDate(notebookId: string): string | null {
    const row = this.db
      .prepare('SELECT MIN(date) AS first FROM journal_entries WHERE notebook_id = ?')
      .get(notebookId) as { first: string | null } | undefined;
    return row?.first ?? null;
  }

  /** How many days a notebook has logged. The directory's count (`P01`). */
  count(notebookId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE notebook_id = ?')
      .get(notebookId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * The day a notebook's calendar begins (criterion P03).
   *
   * The researcher's `journal_start` wins, because they are the only one who knows when the
   * work started: a notebook opened today to hold six months of reading begins in January,
   * and nothing derivable from the database can know that.
   *
   * With no date set, the notebook's own beginning is the honest fallback — not the day the
   * database file was made, which is a fact about the installation and put every notebook's
   * calendar at the same place. An older entry still wins over both: a day backfilled or
   * carried over from a journal kept elsewhere must not fall off the front of the calendar.
   */
  start(notebookId: string): string {
    const row = this.db
      .prepare('SELECT journal_start, created_at FROM questions WHERE id = ?')
      .get(notebookId) as { journal_start: string | null; created_at: string } | undefined;
    const chosen = row?.journal_start ?? null;
    const born = localDay(row?.created_at ?? this.clock.now());
    const first = this.firstDate(notebookId);
    const floor = chosen ?? born;
    return first !== null && first < floor ? first : floor;
  }
}
