import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { Clock } from '../clock.js';

interface SettingRow {
  readonly key: string;
  readonly value_json: string;
  readonly updated_at: string;
}

/**
 * Application settings: one JSON value per key.
 *
 * `get` returns `unknown` on purpose. The database stores what it was given and makes no
 * claim about the shape; the caller validates with the zod schema it already has, which is
 * the same rule the IPC boundary follows. A row that has been hand-edited then fails at the
 * one place that knows what it should have been.
 *
 * A value that will not parse as JSON is treated as absent rather than thrown: a corrupt
 * preference should send the app back to its default, not stop it from starting.
 */
export class SettingsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  get(key: string): unknown {
    const row = this.db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as
      | SettingRow
      | undefined;
    if (row === undefined) return null;
    try {
      return JSON.parse(row.value_json) as unknown;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value ?? null), this.clock.now());
  }

  delete(key: string): boolean {
    return this.db.prepare('DELETE FROM settings WHERE key = ?').run(key).changes > 0;
  }

  keys(): string[] {
    const rows = this.db.prepare('SELECT key FROM settings ORDER BY key').all() as Array<{
      key: string;
    }>;
    return rows.map((row) => row.key);
  }
}
