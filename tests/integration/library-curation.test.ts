/**
 * A library you curate (criteria B01, B03, B04, and the dialog half of B02).
 *
 * The library is not a mirror of Zotero. It is what the researcher is working on, which means
 * things have to be able to leave it. A removal means **not now**, not never: Zotero is still
 * the shelf the paper came from, so the way back is the importer — find the collection, import
 * it, it returns. There is no list of removed things to curate, and no undo button, because
 * either one would be a blacklist the researcher then has to maintain.
 *
 * That makes two claims, and both are asserted here. A routine import — the whole library,
 * `force` included, the run that re-reads every item — leaves a removal alone, or curating the
 * library would last until the next sync. An import **scoped to a collection holding the item**
 * brings it back, with the highlights and links still on it, because naming the collection is
 * the researcher asking for what is in it.
 *
 * The removal is also not allowed to take the researcher's own work with it. Highlights and
 * the edges tying a paper to a question are theirs; Zotero never knew about them and a
 * removal is not entitled to destroy them.
 *
 * Everything runs through the real router — schema validation, the real handlers, a real
 * database, the real importer over the recorded fixtures — because the round trip B01
 * describes lives in the seam between the removal and the import, and a test that called the
 * repository directly would not cross it.
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

interface Victim {
  readonly id: string;
  readonly title: string;
  readonly key: string;
  /** A collection this document is filed in — the one an import names to get it back. */
  readonly collection: string;
  /** A collection it is *not* filed in, so "any import" can be told from "this one". */
  readonly otherCollection: string;
}

/**
 * Import the fixtures and return the document the tests will take out of the library.
 *
 * The pick is a document that is filed somewhere, because the way back is its collection: a
 * paper in no collection at all can be removed but has no shelf to be asked for from, and the
 * fixtures contain one of those on purpose.
 */
async function importAndPickVictim(): Promise<Victim> {
  await call('zotero:import', {});
  const collections = services.db.collections.list();
  const byId = new Map(collections.map((collection) => [collection.id, collection]));

  for (const item of services.db.library.list({ source: ZOTERO_PROVIDER, limit: 200 }).items) {
    const mine = services.db.collections.collectionIdsForDocument(item.document.id);
    const collection = byId.get(mine[0] ?? '')?.name;
    if (collection === undefined) continue;

    // A scoped import covers subcollections, so the collections that would bring this
    // document back are its own *and every ancestor of them*. "Another collection" has to be
    // outside that set or it would prove nothing.
    const covering = new Set<string>();
    for (const id of mine) {
      for (let node = byId.get(id); node !== undefined; node = byId.get(node.parentId ?? '')) {
        covering.add(node.name);
      }
    }
    const otherCollection = collections.map((c) => c.name).find((name) => !covering.has(name));
    if (otherCollection === undefined) continue;

    return {
      id: item.document.id,
      title: item.document.title,
      key: zoteroKeyOf(item.document.id),
      collection,
      otherCollection,
    };
  }
  throw new Error('the fixtures imported no document filed in a collection');
}

describe('a document leaves the library, and its collection brings it back', () => {
  it('[B01] a removed document comes back when its collection is imported again', async () => {
    const victim = await importAndPickVictim();
    const rowsBefore = rowCount();

    const removal = await call<{ removed: boolean }>('library:removeDocument', {
      documentId: victim.id,
    });
    expect(removal.removed).toBe(true);
    expect(liveIds()).not.toContain(victim.id);

    const summary = await call<{ documentsRestored: number; documentsRemoved: number }>(
      'zotero:import',
      { collection: victim.collection },
    );

    expect(summary.documentsRestored).toBe(1);
    expect(summary.documentsRemoved).toBe(0);
    expect(liveIds()).toContain(victim.id);

    // The same document, not a second one wearing its title: a re-import that resurrected it
    // as an unknown key would leave the library holding two of everything ever removed.
    expect(rowCount()).toBe(rowsBefore);
    expect(
      services.db.externalReferences.resolveEntityId(ZOTERO_PROVIDER, 'document', victim.key),
    ).toBe(victim.id);
    expect(services.db.externalReferences.isRemoved(ZOTERO_PROVIDER, 'document', victim.key)).toBe(
      false,
    );

    // And it is searchable again. The chunks were never thrown away; the entries pointing at
    // them were, and a document you cannot find is only half back.
    //
    // Asserted by draining the queue and searching, not by finding a queued row: an
    // `index-fts` job used to be enqueued by a producer with no consumer, so the row existed
    // forever and "queued to be reindexed" and "never reindexed" had the same observable.
    await services.pipeline.drain();
    expect(services.db.searchIndex.countForDocument(victim.id)).toBeGreaterThan(0);
    expect(services.db.jobs.findPending(victim.id, 'index-fts')).toBeNull();
  });

  it('[B01] a routine import leaves a removal alone', async () => {
    const victim = await importAndPickVictim();
    await call('library:removeDocument', { documentId: victim.id });

    // The run that would undo the morning's curation: the whole library, `force` re-reading
    // every item regardless of its version, which is what a repair run does after a mapping
    // fix. A removal means "not now" — a sync nobody aimed at this paper must not answer it.
    const summary = await call<{ documentsRemoved: number; documentsRestored: number }>(
      'zotero:import',
      { force: true },
    );

    expect(summary.documentsRemoved).toBeGreaterThan(0);
    expect(summary.documentsRestored).toBe(0);
    expect(liveIds()).not.toContain(victim.id);
    expect(services.db.library.list({ limit: 200 }).items.map((item) => item.document.title)).not.toContain(
      victim.title,
    );
  });

  it('[B01] a routine import leaves a removal alone even when the picks cover it', async () => {
    const victim = await importAndPickVictim();

    // The state the researcher is actually in: they have ticked the collections this project
    // lives in, so every routine sync is already narrowed to them. That standing scope covers
    // the paper they just removed — it is the shelf the paper sits on.
    await call('zotero:setImportScope', { collections: [victim.collection] });
    await call('library:removeDocument', { documentId: victim.id });

    // Now the ordinary Import button, which names no collection and picks the scope up from
    // the remembered picks. It must still be a routine sync: the picks narrow what is read,
    // and a filter set last week is not the researcher asking for this paper back today.
    // Without that distinction the removal is undone by the next sync, which is the blacklist
    // problem wearing the opposite face — curation that will not survive the morning.
    const summary = await call<{ documentsRestored: number; documentsRemoved: number }>(
      'zotero:import',
      { force: true },
    );

    expect(summary.documentsRestored).toBe(0);
    expect(summary.documentsRemoved).toBeGreaterThan(0);
    expect(liveIds()).not.toContain(victim.id);

    // And naming that same collection still brings it back, so the fix narrowed what restores
    // rather than removing the way back.
    const asked = await call<{ documentsRestored: number }>('zotero:import', {
      collection: victim.collection,
    });
    expect(asked.documentsRestored).toBe(1);
    expect(liveIds()).toContain(victim.id);
  });

  it('[B01] importing a different collection does not bring it back', async () => {
    const victim = await importAndPickVictim();
    await call('library:removeDocument', { documentId: victim.id });

    const summary = await call<{ documentsRestored: number }>('zotero:import', {
      collection: victim.otherCollection,
      force: true,
    });

    // Scoping is what makes the round trip a *request*. A collection the paper is not filed
    // in says nothing about it, and an import that took every scope as "restore everything"
    // would be the blacklist-free version of the same bug.
    expect(summary.documentsRestored).toBe(0);
    expect(liveIds()).not.toContain(victim.id);
  });

  it('[B01] the removal outlives a restart', async () => {
    const victim = await importAndPickVictim();
    await call('library:removeDocument', { documentId: victim.id });

    restart();
    const summary = await call<{ documentsRemoved: number }>('zotero:import', {});

    expect(summary.documentsRemoved).toBeGreaterThan(0);
    expect(liveIds()).not.toContain(victim.id);

    // Still true after the restart: the way back is the collection, and it still works.
    restart();
    await call('zotero:import', { collection: victim.collection });
    expect(liveIds()).toContain(victim.id);
  });

  it('[B01] removing one document leaves the rest of the library alone', async () => {
    const victim = await importAndPickVictim();
    const survivors = liveIds().filter((id) => id !== victim.id);
    expect(survivors.length).toBeGreaterThan(0);

    await call('library:removeDocument', { documentId: victim.id });
    await call('zotero:import', { force: true });

    for (const id of survivors) expect(liveIds()).toContain(id);
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

  it('[B03] importing the collection again gives the work back with the document', async () => {
    const victim = await importAndPickVictim();
    const { annotationId, questionId } = await annotateAndLink(victim.id);
    await call('library:removeDocument', { documentId: victim.id });

    // Reachable, which is what makes "recoverable" true rather than merely technically true:
    // the researcher asks for the collection back and the work comes with the paper. There is
    // no removed-things list to find it in, on purpose — the shelf it came from is the list.
    await call('zotero:import', { collection: victim.collection });
    expect(liveIds()).toContain(victim.id);

    const annotations = await call<{ annotations: ReadonlyArray<{ id: string }> }>(
      'annotation:listByDocument',
      { documentId: victim.id },
    );
    expect(annotations.annotations.map((row) => row.id)).toContain(annotationId);

    // The paper is still referred to on the notebook's page: the edge was never the
    // document's to lose, and neither is the block that names it (`P06`).
    const { page } = await call<{ page: { body: string } }>('question:notebook', { questionId });
    expect(page.body).toContain(`#link("document://${victim.id}")`);
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

  it('[B03] a highlight answers searches again once the paper is back', async () => {
    const victim = await importAndPickVictim();
    const { annotationId } = await annotateAndLink(victim.id);
    services.db.searchIndex.upsert({
      entityType: 'annotation',
      entityId: annotationId,
      documentId: victim.id,
      title: 'the claim',
      body: 'the claim this paper is actually about',
      meta: '',
    });

    await call('library:removeDocument', { documentId: victim.id });
    expect(services.db.searchIndex.countForDocument(victim.id)).toBe(0);

    await call('zotero:import', { collection: victim.collection });
    await services.pipeline.drain();

    // The highlight, not merely the paper, and asked for the way the researcher would ask —
    // through the search channel, for the words they selected. The removal dropped every
    // entry carrying this document id, annotations included; a restore that rebuilt only the
    // document record would leave their own words permanently unfindable while the paper sat
    // back on the shelf looking whole, which is the failure nobody notices until they search.
    const { results } = await call<{
      results: ReadonlyArray<{ entityType: string; entityId: string }>;
    }>('search:query', { query: 'induction heads' });

    expect(
      results.filter((hit) => hit.entityType === 'annotation').map((hit) => hit.entityId),
    ).toContain(annotationId);
  });
});

describe('the Zotero library is never written to', () => {
  it('[B04] every library edit leaves ~/Zotero/zotero.sqlite untouched', async () => {
    const before = factsOf(zoteroSqlite);

    // The whole of milestone 4's curation, in one run: import, remove, re-import forcing a
    // re-read, import the collection to bring it back, and add a file from the disk that
    // Zotero has never heard of.
    const victim = await importAndPickVictim();
    await call('library:removeDocument', { documentId: victim.id });
    await call('zotero:import', { force: true });
    await call('zotero:import', { collection: victim.collection });

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
