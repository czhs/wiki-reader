/**
 * A library you curate (criteria B01, B03, B04, and the dialog half of B02).
 *
 * The library is not a mirror of Zotero. It is what the researcher is working on, which means
 * things have to be able to leave it — and *stay* gone. The obvious implementation of leaving
 * is `DELETE FROM documents`, and it is wrong in a way that only shows up later: the next
 * import finds an item key it has no record of and creates the document again. So every test
 * here that removes something imports again afterwards, including with `force`, which is the
 * run that re-reads every item and would resurrect anything a version check was hiding.
 *
 * The removal is also not allowed to take the researcher's own work with it. Highlights and
 * the edges tying a paper to a question are theirs; Zotero never knew about them and a
 * removal is not entitled to destroy them.
 *
 * Everything runs through the real router — schema validation, the real handlers, a real
 * database, the real importer over the recorded fixtures — because the bug B01 describes
 * lives in the seam between the removal and the import, and a test that called the repository
 * directly would not cross it.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@wr/database';
import { createPdfAnchor } from '@wr/document-model';
import { ZOTERO_PROVIDER } from '@wr/zotero-adapter';
import { createTestServices, type AppServices } from '../../apps/desktop/src/main/services.js';
import { createHandlers } from '../../apps/desktop/src/main/handlers.js';
import { dispatch } from '../../apps/desktop/src/main/router.js';
import { silentLogger } from '../../apps/desktop/src/main/logger.js';
import { fixtureFetch } from '../../packages/zotero-adapter/test/fake-api.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_PDF = join(REPO_ROOT, 'tests', 'fixtures', 'sample-paper.pdf');

let dir: string;
let zoteroDataDir: string;
let zoteroSqlite: string;
let databasePath: string;
let services: AppServices;
/** Paths the injected file dialog will answer with, so B02's chooser has something to pick. */
let picked: readonly string[] | null;

/**
 * A `zotero.sqlite` where Zotero keeps one, so "untouched" is a claim about a real file.
 *
 * A genuine SQLite database rather than a placeholder: the invariant is that this application
 * never opens the library database at all, and a file that could not be opened even if it
 * tried would make the assertion vacuous.
 */
function writeZoteroDatabase(path: string): void {
  const { db } = openDatabase({ file: path, migrate: false });
  db.sqlite.exec(
    `CREATE TABLE items (itemID INTEGER PRIMARY KEY, key TEXT NOT NULL, version INTEGER);
     INSERT INTO items (key, version) VALUES ('VWPWR9BS', 3), ('438MK4WU', 7);`,
  );
  db.close();
}

interface FileFacts {
  readonly sha256: string;
  readonly size: number;
  readonly mtimeMs: number;
}

function factsOf(path: string): FileFacts {
  const stats = statSync(path);
  return {
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function start(): void {
  services = createTestServices({
    databasePath,
    zoteroDataDir,
    zoteroFetch: fixtureFetch(),
    chooseFiles: () => Promise.resolve(picked),
  });
}

beforeEach(() => {
  // Resolved through the symlink macOS puts in front of `/tmp`, because `LocalFileLibrary`
  // admits the path the filesystem reports and the test compares against it.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wr-curation-')));
  zoteroDataDir = join(dir, 'Zotero');
  mkdirSync(zoteroDataDir, { recursive: true });
  zoteroSqlite = join(zoteroDataDir, 'zotero.sqlite');
  writeZoteroDatabase(zoteroSqlite);
  databasePath = join(dir, 'wiki-reader.db');
  picked = null;
  start();
});

afterEach(() => {
  services.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Send a request the way the renderer would: through the router and its validation. */
async function call<T>(channel: string, request: unknown = {}): Promise<T> {
  const result = await dispatch(createHandlers(services), channel, request, silentLogger);
  if (!result.ok) throw new Error(`${channel} failed: ${result.error.code} ${result.error.message}`);
  return result.value as T;
}

/** Close the app and open it again over the same database, as a restart does. */
function restart(): void {
  services.close();
  start();
}

interface LibraryListing {
  readonly items: ReadonlyArray<{ readonly document: { readonly id: string; readonly title: string } }>;
}

/** The document ids the library shows. */
function liveIds(): string[] {
  return services.db.library.list({ limit: 200 }).items.map((item) => item.document.id);
}

/** Every document row, hidden ones included — what a resurrection would add to. */
function rowCount(): number {
  return (
    services.db.sqlite.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }
  ).n;
}

function zoteroKeyOf(documentId: string): string {
  const reference = services.db.externalReferences
    .listForEntity('document', documentId)
    .find((row) => row.provider === ZOTERO_PROVIDER);
  if (reference === undefined) throw new Error(`no zotero key for ${documentId}`);
  return reference.externalKey;
}

/** Import the fixtures and return the document the tests will take out of the library. */
async function importAndPickVictim(): Promise<{ id: string; title: string; key: string }> {
  await call('zotero:import', {});
  const first = services.db.library.list({ source: ZOTERO_PROVIDER, limit: 1 }).items[0];
  if (first === undefined) throw new Error('the fixtures imported nothing to remove');
  return {
    id: first.document.id,
    title: first.document.title,
    key: zoteroKeyOf(first.document.id),
  };
}

describe('a document leaves the library and stays gone', () => {
  it('[B01] a removed document is not brought back by the next import', async () => {
    const victim = await importAndPickVictim();
    const rowsBefore = rowCount();

    const removal = await call<{ removed: boolean }>('library:removeDocument', {
      documentId: victim.id,
    });
    expect(removal.removed).toBe(true);
    expect(liveIds()).not.toContain(victim.id);

    // The run that would resurrect it: `force` re-reads every item regardless of its version,
    // which is exactly what a repair run does after a mapping fix.
    const summary = await call<{ documentsRemoved: number; documentsCreated: number }>(
      'zotero:import',
      { force: true },
    );

    expect(summary.documentsRemoved).toBeGreaterThan(0);
    expect(liveIds()).not.toContain(victim.id);
    // Not resurrected under a *new* id either, which is what deleting the reference row
    // instead of tombstoning it would produce: an item the import has never seen.
    expect(rowCount()).toBe(rowsBefore);
    expect(services.db.library.list({ limit: 200 }).items.map((item) => item.document.title)).not.toContain(
      victim.title,
    );
    expect(
      services.db.externalReferences.resolveEntityId(ZOTERO_PROVIDER, 'document', victim.key),
    ).toBe(victim.id);
    expect(services.db.externalReferences.isRemoved(ZOTERO_PROVIDER, 'document', victim.key)).toBe(
      true,
    );
  });

  it('[B01] the removal outlives a restart', async () => {
    const victim = await importAndPickVictim();
    await call('library:removeDocument', { documentId: victim.id });

    restart();
    const summary = await call<{ documentsRemoved: number }>('zotero:import', {});

    expect(summary.documentsRemoved).toBeGreaterThan(0);
    expect(liveIds()).not.toContain(victim.id);
  });

  it('[B01] removing one document leaves the rest of the library alone', async () => {
    const victim = await importAndPickVictim();
    const survivors = liveIds().filter((id) => id !== victim.id);
    expect(survivors.length).toBeGreaterThan(0);

    await call('library:removeDocument', { documentId: victim.id });
    await call('zotero:import', { force: true });

    for (const id of survivors) expect(liveIds()).toContain(id);
  });

  it('[B01] a restored document is imported again', async () => {
    const victim = await importAndPickVictim();
    await call('library:removeDocument', { documentId: victim.id });
    await call('library:restoreDocument', { documentId: victim.id });

    const summary = await call<{ documentsRemoved: number }>('zotero:import', { force: true });

    // The tombstone is gone, so the item is ordinary again — a removal that could not be
    // undone would be a decision the researcher makes once and lives with forever.
    expect(summary.documentsRemoved).toBe(0);
    expect(liveIds()).toContain(victim.id);
    expect(services.db.externalReferences.isRemoved(ZOTERO_PROVIDER, 'document', victim.key)).toBe(
      false,
    );
  });
});

describe('what a removal must not destroy', () => {
  /** Highlight the document and tie it to a question, the way a week of work would. */
  async function annotateAndLink(documentId: string): Promise<{
    annotationId: string;
    questionId: string;
  }> {
    const { annotation } = await call<{ annotation: { id: string } }>('annotation:create', {
      documentId,
      kind: 'highlight',
      color: 'default',
      selectedText: 'induction heads',
      comment: 'the claim this paper is actually about',
      anchor: createPdfAnchor({
        selection: {
          kind: 'pdf',
          pageIndex: 0,
          rects: [{ x1: 0.1, y1: 0.2, x2: 0.7, y2: 0.22 }],
          text: 'induction heads',
          pageText: 'We show that induction heads emerge during a phase change in training.',
          position: { start: 13, end: 28 },
        },
        contentHash: 'a'.repeat(64),
      }),
    });

    const { question } = await call<{ question: { id: string } }>('question:create', {
      title: 'Which papers actually show the copying circuit?',
    });
    await call('question:attach', {
      questionId: question.id,
      targetType: 'document',
      targetId: documentId,
    });

    return { annotationId: annotation.id, questionId: question.id };
  }

  it('[B03] a removal keeps the annotations and links made on the document', async () => {
    const victim = await importAndPickVictim();
    const { annotationId } = await annotateAndLink(victim.id);

    const removal = await call<{ annotationsKept: number; linksKept: number }>(
      'library:removeDocument',
      { documentId: victim.id },
    );

    expect(removal.annotationsKept).toBeGreaterThan(0);
    expect(removal.linksKept).toBeGreaterThan(0);

    // Still there, comment and all — not a row whose text was thrown away and whose id
    // survives to point at nothing.
    const annotation = services.db.annotations.get(annotationId);
    expect(annotation).not.toBeNull();
    expect(annotation?.comment).toBe('the claim this paper is actually about');
    expect(annotation?.deletedAt).toBeNull();
    expect(
      services.db.links.findReferences({
        entityType: 'document',
        entityId: victim.id,
        direction: 'both',
      }).length,
    ).toBeGreaterThan(0);
  });

  it('[B03] a removed document is listed, and restoring gives its work back', async () => {
    const victim = await importAndPickVictim();
    const { annotationId, questionId } = await annotateAndLink(victim.id);
    await call('library:removeDocument', { documentId: victim.id });

    // Findable: work the researcher cannot reach has been destroyed as far as they are
    // concerned, whatever the rows say.
    const removed = await call<LibraryListing>('library:listRemoved', {});
    expect(removed.items.map((item) => item.document.id)).toContain(victim.id);

    const restored = await call<{ restored: boolean }>('library:restoreDocument', {
      documentId: victim.id,
    });
    expect(restored.restored).toBe(true);
    expect(liveIds()).toContain(victim.id);

    const annotations = await call<{ annotations: ReadonlyArray<{ id: string }> }>(
      'annotation:listByDocument',
      { documentId: victim.id },
    );
    expect(annotations.annotations.map((row) => row.id)).toContain(annotationId);

    // The card is still on the question's board: the edge was never the document's to lose.
    const { page } = await call<{ page: { cards: ReadonlyArray<{ entityId: string }> } }>(
      'question:notebook',
      { questionId },
    );
    expect(page.cards.map((card) => card.entityId)).toContain(victim.id);
  });

  it('[B03] a removed document stops answering searches', async () => {
    const victim = await importAndPickVictim();
    services.db.searchIndex.upsert({
      entityType: 'document',
      entityId: victim.id,
      documentId: victim.id,
      title: victim.title,
      body: 'phase change induction heads',
      meta: '',
    });
    expect(services.db.searchIndex.countForDocument(victim.id)).toBeGreaterThan(0);

    await call('library:removeDocument', { documentId: victim.id });

    // A hit that opens something the library says is not there is worse than no hit.
    expect(services.db.searchIndex.countForDocument(victim.id)).toBe(0);
  });
});

describe('the Zotero library is never written to', () => {
  it('[B04] every library edit leaves ~/Zotero/zotero.sqlite untouched', async () => {
    const before = factsOf(zoteroSqlite);

    // The whole of milestone 4's curation, in one run: import, remove, re-import forcing a
    // re-read, restore, and add a file from the disk that Zotero has never heard of.
    const victim = await importAndPickVictim();
    await call('library:removeDocument', { documentId: victim.id });
    await call('zotero:import', { force: true });
    await call('library:restoreDocument', { documentId: victim.id });

    const inbox = join(dir, 'inbox');
    mkdirSync(inbox, { recursive: true });
    const paper = join(inbox, 'copying-circuit.pdf');
    copyFileSync(FIXTURE_PDF, paper);
    picked = [paper];
    await call('library:addFiles', {});

    const after = factsOf(zoteroSqlite);
    expect(after.sha256).toBe(before.sha256);
    expect(after.size).toBe(before.size);
    // Not even opened: SQLite touches the file's mtime on a write, and a journal or WAL
    // sidecar beside it is the other trace an opened database leaves.
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(statSync(`${zoteroSqlite}-wal`, { throwIfNoEntry: false })).toBeUndefined();
    expect(statSync(`${zoteroSqlite}-journal`, { throwIfNoEntry: false })).toBeUndefined();
  });
});

describe('a file from the disk, without Zotero', () => {
  it('[B02] the dialog adds a file where it lies, and it opens from the library', async () => {
    const inbox = join(dir, 'inbox');
    mkdirSync(inbox, { recursive: true });
    const paper = join(inbox, 'copying-circuit.pdf');
    copyFileSync(FIXTURE_PDF, paper);
    picked = [paper];

    const result = await call<{ chose: boolean; added: number; documentIds: string[] }>(
      'library:addFiles',
      {},
    );

    expect(result.chose).toBe(true);
    expect(result.added).toBe(1);
    const documentId = result.documentIds[0];
    if (documentId === undefined) throw new Error('nothing was added');

    // Where it lies: the library row names the original file, and no copy was made.
    const file = services.db.files.primaryForDocument(documentId);
    expect(file?.path).toBe(paper);
    expect(services.db.documents.getById(documentId)?.source).toBe('local');

    // And the bytes are reachable the way every other document's are, which they can only be
    // because adding the file admitted that one path.
    expect(await services.localFiles.readable(paper)).toBe(true);

    const opened = await call<{ file: { url: string } }>('document:openFile', {
      fileId: file?.id ?? '',
    });
    expect(opened.file.url).toBe(`rrfile://${file?.id ?? ''}`);
  });

  it('[B03] adding a removed file again puts it back rather than doing nothing', async () => {
    const inbox = join(dir, 'inbox');
    mkdirSync(inbox, { recursive: true });
    const paper = join(inbox, 'copying-circuit.pdf');
    copyFileSync(FIXTURE_PDF, paper);
    picked = [paper];

    const first = await call<{ documentIds: string[] }>('library:addFiles', {});
    const documentId = first.documentIds[0];
    if (documentId === undefined) throw new Error('nothing was added');
    await call('library:removeDocument', { documentId });
    expect(liveIds()).not.toContain(documentId);

    // The library row is idempotent by path, so without an explicit restore this would add a
    // file to a library that goes on not showing it — a drop that does nothing visible.
    const again = await call<{ added: number; documentIds: string[] }>('library:addFiles', {});
    expect(again.documentIds).toEqual([documentId]);
    expect(liveIds()).toContain(documentId);
  });

  it('[B02] a cancelled dialog changes nothing', async () => {
    picked = null;
    const result = await call<{ chose: boolean; added: number }>('library:addFiles', {});
    expect(result.chose).toBe(false);
    expect(result.added).toBe(0);
    expect(liveIds()).toHaveLength(0);
  });
});
