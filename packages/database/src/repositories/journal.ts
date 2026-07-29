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

  /** The earliest day with an entry. Null on a journal nobody has written in. */
  firstDate(): string | null {
    const row = this.db.prepare('SELECT MIN(date) AS first FROM journal_entries').get() as
      | { first: string | null }
      | undefined;
    return row?.first ?? null;
  }

  /**
   * The day the project began, which is where the calendar starts (criterion N10).
   *
   * Not the first day anyone wrote on: a fortnight of reading before the first entry is still
   * a fortnight of the project, and a calendar that begins at the first entry cannot show that
   * nothing was logged during it. The wiki's own beginning is when its database was made, so
   * that is what this reads — the earliest migration, which every library has.
   *
   * The earliest entry still counts, and wins when it is older. A journal restored from
   * elsewhere, or backfilled by hand, has days that predate this database file, and dropping
   * them off the front of the calendar would hide entries that exist.
   */
  projectStart(): string {
    const row = this.db
      .prepare('SELECT MIN(applied_at) AS created FROM schema_migrations')
      .get() as { created: string | null } | undefined;
    const created = localDay(row?.created ?? this.clock.now());
    const first = this.firstDate();
    return first !== null && first < created ? first : created;
  }
}

/**
 * The local calendar day an instant falls on.
 *
 * The calendar's days are the ones on the researcher's wall, not UTC days: an entry written
 * at 9pm on the 3rd in UTC+13 belongs to the 3rd. Timestamps are stored as UTC instants, so
 * the conversion happens here rather than by slicing the string.
 */
function localDay(timestamp: string): string {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return timestamp.slice(0, 10);
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${String(at.getFullYear())}-${month}-${day}`;
}
