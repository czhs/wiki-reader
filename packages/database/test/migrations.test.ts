import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  MigrationChecksumError,
  fixedClock,
  foreignKeysEnabled,
  fts5Available,
  listAppliedMigrations,
  openDatabase,
  openSqlite,
  runMigrations,
  schemaVersion,
} from '../src/index.js';
import { createTempDatabase, type TempDatabase } from './helpers.js';

/** Every table `docs/SPEC.md` § Database requires. */
const REQUIRED_TABLES = [
  'documents',
  'document_files',
  'document_revisions',
  'document_chunks',
  'annotations',
  'annotation_anchors',
  'notes',
  'links',
  'collections',
  'document_collections',
  'tags',
  'document_tags',
  'reading_positions',
  'workspace_layouts',
  'external_references',
  'indexing_jobs',
];

/** The link indexes the spec names explicitly. */
const REQUIRED_LINK_INDEXES = [
  'links_source_idx',
  'links_target_idx',
  'links_type_idx',
  'links_type_source_idx',
  'links_type_target_idx',
];

function tableNames(temp: TempDatabase): string[] {
  const rows = temp.db.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('migrations', () => {
  const temps: TempDatabase[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    while (temps.length > 0) temps.pop()?.cleanup();
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  function fresh(): TempDatabase {
    const temp = createTempDatabase('wr-migrations');
    temps.push(temp);
    return temp;
  }

  it('[M03] creates every specified table on a fresh database', () => {
    const temp = fresh();
    const names = tableNames(temp);
    for (const table of REQUIRED_TABLES) {
      expect(names, `missing table ${table}`).toContain(table);
    }
  });

  it('[M03] reports the latest schema version after initialization', () => {
    const temp = fresh();
    expect(temp.db.version()).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('[M03] enables foreign keys and FTS5 on the connection', () => {
    const temp = fresh();
    expect(foreignKeysEnabled(temp.db.sqlite)).toBe(true);
    expect(fts5Available(temp.db.sqlite)).toBe(true);
  });

  it('[M03] creates the FTS5 index and keeps it in step with the projection table', () => {
    const temp = fresh();
    const document = temp.db.documents.create({
      title: 'Attention Is All You Need',
      docType: 'pdf',
      source: 'test',
    });
    temp.db.searchIndex.upsert({
      entityType: 'document',
      entityId: document.id,
      documentId: document.id,
      title: document.title,
      body: 'the dominant sequence transduction models are based on recurrent networks',
    });

    const hit = temp.db.sqlite
      .prepare(
        `SELECT e.entity_id FROM search_fts f
           JOIN search_entries e ON e.rowid = f.rowid
          WHERE search_fts MATCH ?`,
      )
      .get('transduction') as { entity_id: string } | undefined;
    expect(hit?.entity_id).toBe(document.id);

    // Removing the projection row must remove it from the index too, or deleted
    // documents keep showing up in search results.
    temp.db.searchIndex.remove('document', document.id);
    const afterDelete = temp.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM search_fts WHERE search_fts MATCH ?')
      .get('transduction') as { n: number };
    expect(afterDelete.n).toBe(0);
  });

  it('[M03] persists the schema across a close and reopen', () => {
    const temp = fresh();
    const before = temp.db.version();
    const reopened = temp.reopen();
    expect(reopened.version()).toBe(before);
    expect(tableNames(temp)).toEqual(expect.arrayContaining(REQUIRED_TABLES));
  });

  it('[T01] applies every migration forward on a fresh database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-fwd-'));
    dirs.push(dir);
    const sqlite = openSqlite({ file: join(dir, 'db.sqlite') });
    try {
      expect(schemaVersion(sqlite)).toBe(0);
      const result = runMigrations(sqlite, MIGRATIONS, fixedClock('2026-01-01T00:00:00.000Z').now);
      expect(result.applied).toEqual(MIGRATIONS.map((m) => m.id));
      expect(result.version).toBe(LATEST_SCHEMA_VERSION);
      expect(listAppliedMigrations(sqlite).map((m) => m.name)).toEqual(
        MIGRATIONS.map((m) => m.name),
      );
    } finally {
      sqlite.close();
    }
  });

  it('[T01] is idempotent: running the migrator again applies nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-idem-'));
    dirs.push(dir);
    const sqlite = openSqlite({ file: join(dir, 'db.sqlite') });
    try {
      runMigrations(sqlite);
      const second = runMigrations(sqlite);
      expect(second.applied).toEqual([]);
      expect(second.version).toBe(LATEST_SCHEMA_VERSION);
      expect(listAppliedMigrations(sqlite)).toHaveLength(MIGRATIONS.length);

      const third = runMigrations(sqlite);
      expect(third.applied).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('[T01] enforces foreign keys: a child row cannot reference a missing parent', () => {
    const temp = fresh();
    expect(() =>
      temp.db.sqlite
        .prepare(
          `INSERT INTO annotations
             (id, document_id, revision_id, kind, color, selected_text, comment,
              created_at, updated_at, deleted_at)
           VALUES ('ann_x', 'doc_does_not_exist', NULL, 'highlight', '#ff0', 'x', NULL,
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('[T01] cascades deletes from a document to its dependent rows', () => {
    const temp = fresh();
    const document = temp.db.documents.create({ title: 'Doc', docType: 'pdf', source: 'test' });
    const { revision } = temp.db.revisions.createIfChanged({
      documentId: document.id,
      contentHash: 'sha256:aa',
    });
    temp.db.chunks.replaceForRevision(document.id, revision.id, [
      { chunkIndex: 0, kind: 'pdf-page', pageIndex: 0, charStart: 0, charEnd: 5, text: 'hello' },
    ]);
    expect(temp.db.chunks.countForDocument(document.id)).toBe(1);

    temp.db.sqlite.prepare('DELETE FROM documents WHERE id = ?').run(document.id);
    expect(temp.db.chunks.countForDocument(document.id)).toBe(0);
    const revisions = temp.db.revisions.listForDocument(document.id);
    expect(revisions).toEqual([]);
  });

  it('[T01] refuses to run a migration whose SQL changed after it was applied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-checksum-'));
    dirs.push(dir);
    const sqlite = openSqlite({ file: join(dir, 'db.sqlite') });
    try {
      runMigrations(sqlite);
      const tampered = MIGRATIONS.map((migration) =>
        migration.id === 1 ? { ...migration, sql: `${migration.sql}\n-- edited` } : migration,
      );
      expect(() => runMigrations(sqlite, tampered)).toThrow(MigrationChecksumError);
    } finally {
      sqlite.close();
    }
  });

  it('[T01] leaves the database untouched when a migration fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-rollback-'));
    dirs.push(dir);
    const sqlite = openSqlite({ file: join(dir, 'db.sqlite') });
    try {
      runMigrations(sqlite);
      const broken = [
        ...MIGRATIONS,
        {
          id: 999,
          name: '999_broken',
          sql: 'CREATE TABLE ok_so_far (id TEXT); THIS IS NOT SQL;',
        },
      ];
      expect(() => runMigrations(sqlite, broken)).toThrow();

      // The half-applied statement must not survive, and the version must not move.
      const leftover = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name = 'ok_so_far'")
        .get() as { name: string } | undefined;
      expect(leftover).toBeUndefined();
      expect(schemaVersion(sqlite)).toBe(LATEST_SCHEMA_VERSION);
      expect(listAppliedMigrations(sqlite).some((m) => m.id === 999)).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  /**
   * The one migration in the tree that has to *carry* data rather than only reshape it.
   *
   * Migration 012 rekeys a day from its date to `(notebook_id, date)` and rewrites the link
   * endpoints that pointed at the old key. Every other test in the suite starts from a fresh
   * database, where the carrying code never runs — so a mistake there would lose a
   * researcher's journal on upgrade and nothing would notice until it had.
   */
  it('[P02] migration 012 carries an existing journal onto a notebook, with its links', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-012-'));
    dirs.push(dir);
    const sqlite = openSqlite({ file: join(dir, 'db.sqlite') });
    try {
      // A library at migration 011: a global journal, keyed by date, with an edge pointing at
      // one of its days — exactly what a researcher upgrading would have on disk.
      const before = MIGRATIONS.filter((migration) => migration.id <= 11);
      runMigrations(sqlite, before);
      sqlite
        .prepare(
          `INSERT INTO journal_entries (date, markdown, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run('2026-03-04', 'Read two papers that disagree.', '2026-03-04T09:00:00.000Z', '2026-03-04T09:00:00.000Z');
      sqlite
        .prepare(
          `INSERT INTO questions (id, title, status, ordinal, created_at, updated_at)
           VALUES (?, ?, 'active', 0, ?, ?)`,
        )
        .run('qst_00000000000000000000000001', 'The work that was already open', '2026-03-01T09:00:00.000Z', '2026-03-01T09:00:00.000Z');
      sqlite
        .prepare(
          `INSERT INTO links (id, type, source_type, source_id, target_type, target_id,
                              origin, created_at, updated_at)
           VALUES (?, 'journal-entry-advances-question', 'journal', '2026-03-04',
                   'question', 'qst_00000000000000000000000001', 'manual', ?, ?)`,
        )
        .run('lnk_00000000000000000000000001', '2026-03-04T09:00:00.000Z', '2026-03-04T09:00:00.000Z');

      runMigrations(sqlite);

      // The day is still there, and it now belongs to the notebook that was already open.
      const entry = sqlite
        .prepare('SELECT notebook_id, date, markdown FROM journal_entries')
        .all() as Array<{ notebook_id: string; date: string; markdown: string }>;
      expect(entry).toHaveLength(1);
      expect(entry[0]?.notebook_id).toBe('qst_00000000000000000000000001');
      expect(entry[0]?.date).toBe('2026-03-04');
      expect(entry[0]?.markdown).toBe('Read two papers that disagree.');

      // And the edge that pointed at "the 4th" points at the 4th *of that notebook*, rather
      // than at an id that no longer resolves to anything.
      const link = sqlite
        .prepare('SELECT source_id FROM links WHERE id = ?')
        .get('lnk_00000000000000000000000001') as { source_id: string } | undefined;
      expect(link?.source_id).toBe('qst_00000000000000000000000001:2026-03-04');
    } finally {
      sqlite.close();
    }
  });

  it('[P02] migration 012 gives a journal with no notebook at all somewhere to live', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-012-orphan-'));
    dirs.push(dir);
    const sqlite = openSqlite({ file: join(dir, 'db.sqlite') });
    try {
      runMigrations(sqlite, MIGRATIONS.filter((migration) => migration.id <= 11));
      sqlite
        .prepare(
          `INSERT INTO journal_entries (date, markdown, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run('2026-03-04', 'Kept a diary before any of this existed.', '2026-03-04T09:00:00.000Z', '2026-03-04T09:00:00.000Z');

      runMigrations(sqlite);

      // Deleting the day would have been the tidier migration and the wrong one: a notebook
      // is created for it, and the entry arrives under an id the app can address.
      const rows = sqlite
        .prepare(
          `SELECT j.date AS date, j.markdown AS markdown, q.title AS title, q.id AS id
             FROM journal_entries j JOIN questions q ON q.id = j.notebook_id`,
        )
        .all() as Array<{ date: string; markdown: string; title: string; id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.markdown).toBe('Kept a diary before any of this existed.');
      expect(rows[0]?.title).toBe('Field notebook');
      expect(rows[0]?.id).toMatch(/^qst_[0-9a-hjkmnp-tv-z]{26}$/u);
    } finally {
      sqlite.close();
    }
  });

  it('[T01] creates the link indexes the spec names', () => {
    const temp = fresh();
    const rows = temp.db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>;
    const names = rows.map((row) => row.name);
    for (const index of REQUIRED_LINK_INDEXES) {
      expect(names, `missing index ${index}`).toContain(index);
    }
  });

  it('[T01] records a checksum and timestamp for each applied migration', () => {
    const temp = fresh();
    const applied = listAppliedMigrations(temp.db.sqlite);
    expect(applied).toHaveLength(MIGRATIONS.length);
    for (const migration of applied) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{16}$/);
      expect(() => new Date(migration.appliedAt).toISOString()).not.toThrow();
    }
  });

  it('[M03] opens the same file twice without re-applying migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-twice-'));
    dirs.push(dir);
    const file = join(dir, 'db.sqlite');
    const first = openDatabase({ file });
    expect(first.migration.applied).toEqual(MIGRATIONS.map((m) => m.id));
    first.db.close();

    const second = openDatabase({ file });
    expect(second.migration.applied).toEqual([]);
    expect(second.db.version()).toBe(LATEST_SCHEMA_VERSION);
    second.db.close();
  });
});
