import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { JournalEntry } from '@wr/shared-types';
import type { Clock } from '../clock.js';
import { toJournalEntry, type JournalEntryRow } from '../mappers.js';

export interface JournalRangeOptions {
  /** Inclusive ISO date bounds. Omitted means unbounded on that side. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/**
 * The dated research diary: one markdown entry per day, project-global.
 *
 * `write` with blank markdown **deletes** the day rather than storing an empty entry. That
 * is the rule the whole feature turns on: an unlogged day and a day logged with nothing are
 * the same fact, and a calendar that told them apart would be showing a difference that does
 * not exist. The schema refuses the empty string too, so no other writer can reintroduce it.
 */
export class JournalRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  get(date: string): JournalEntry | null {
    const row = this.db.prepare('SELECT * FROM journal_entries WHERE date = ?').get(date) as
      | JournalEntryRow
      | undefined;
    return row === undefined ? null : toJournalEntry(row);
  }

  /** Write the day, or delete it when what was typed is blank. Returns the entry, or null. */
  write(date: string, markdown: string): JournalEntry | null {
    if (markdown.trim() === '') {
      this.delete(date);
      return null;
    }
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO journal_entries (date, markdown, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET markdown = excluded.markdown,
                                         updated_at = excluded.updated_at`,
      )
      .run(date, markdown, now, now);
    const entry = this.get(date);
    if (entry === null) throw new Error('journal.write: row vanished after insert');
    return entry;
  }

  delete(date: string): boolean {
    return this.db.prepare('DELETE FROM journal_entries WHERE date = ?').run(date).changes > 0;
  }

  /** Entries in a date range, oldest first. */
  list(options: JournalRangeOptions = {}): JournalEntry[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.from !== undefined) {
      clauses.push('date >= ?');
      params.push(options.from);
    }
    if (options.to !== undefined) {
      clauses.push('date <= ?');
      params.push(options.to);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const rows = this.db
      .prepare(`SELECT * FROM journal_entries ${where} ORDER BY date`)
      .all(...params) as JournalEntryRow[];
    return rows.map(toJournalEntry);
  }

  /**
   * Which days have an entry.
   *
   * The calendar needs the dates and nothing else — a year of markdown crossing the IPC
   * boundary to decide which bubbles are filled in would be the wrong query.
   */
  loggedDates(options: JournalRangeOptions = {}): string[] {
    return this.list(options).map((entry) => entry.date);
  }

  /** The earliest day with an entry, which is where a calendar starts. */
  firstDate(): string | null {
    const row = this.db.prepare('SELECT MIN(date) AS first FROM journal_entries').get() as
      | { first: string | null }
      | undefined;
    return row?.first ?? null;
  }
}
