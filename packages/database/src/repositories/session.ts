import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { DocumentLocation, ReadingPosition, WorkspaceLayout } from '@wr/shared-types';
import type { Clock } from '../clock.js';
import {
  toReadingPosition,
  toWorkspaceLayout,
  type ReadingPositionRow,
  type WorkspaceLayoutRow,
} from '../mappers.js';

/**
 * Reading positions.
 *
 * One row per document: reopening a PDF restores the page and scroll offset that were
 * last recorded, so "where was I?" survives a restart.
 */
export class ReadingPositionsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  set(documentId: string, location: DocumentLocation): ReadingPosition {
    this.db
      .prepare(
        `INSERT INTO reading_positions (document_id, location_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(document_id) DO UPDATE SET location_json = excluded.location_json,
                                                updated_at = excluded.updated_at`,
      )
      .run(documentId, JSON.stringify(location), this.clock.now());
    const position = this.get(documentId);
    if (position === null) throw new Error('reading_positions.set: row vanished after upsert');
    return position;
  }

  get(documentId: string): ReadingPosition | null {
    const row = this.db
      .prepare('SELECT * FROM reading_positions WHERE document_id = ?')
      .get(documentId) as ReadingPositionRow | undefined;
    return row === undefined ? null : toReadingPosition(row);
  }

  clear(documentId: string): boolean {
    return (
      this.db.prepare('DELETE FROM reading_positions WHERE document_id = ?').run(documentId)
        .changes > 0
    );
  }
}

/**
 * Workspace layouts.
 *
 * The Dockview layout blob is opaque to the main process: it is serialized by the
 * renderer, stored verbatim, and handed back unchanged. `panelState` carries the
 * per-panel context (open document, scroll position, search query) that Dockview itself
 * does not model.
 */
export class WorkspaceLayoutsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  save(name: string, layout: unknown, panelState: Record<string, unknown> = {}): WorkspaceLayout {
    this.db
      .prepare(
        `INSERT INTO workspace_layouts (name, layout_json, panel_state_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET layout_json = excluded.layout_json,
                                         panel_state_json = excluded.panel_state_json,
                                         updated_at = excluded.updated_at`,
      )
      .run(name, JSON.stringify(layout ?? null), JSON.stringify(panelState), this.clock.now());
    const saved = this.load(name);
    if (saved === null) throw new Error('workspace_layouts.save: row vanished after upsert');
    return saved;
  }

  load(name: string): WorkspaceLayout | null {
    const row = this.db
      .prepare('SELECT * FROM workspace_layouts WHERE name = ?')
      .get(name) as WorkspaceLayoutRow | undefined;
    return row === undefined ? null : toWorkspaceLayout(row);
  }

  listNames(): string[] {
    const rows = this.db
      .prepare('SELECT name FROM workspace_layouts ORDER BY name')
      .all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  delete(name: string): boolean {
    return this.db.prepare('DELETE FROM workspace_layouts WHERE name = ?').run(name).changes > 0;
  }
}
