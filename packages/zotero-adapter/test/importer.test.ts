import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, openDatabase, type WikiReaderDatabase } from '@wr/database';
import { ZoteroLocalClient } from '../src/client.js';
import {
  ZoteroImporter,
  ZOTERO_PROVIDER,
  type FileProbe,
  type ImportProgress,
} from '../src/importer.js';
import { fixtureFetch } from './fake-api.js';
import { topItems } from './fixtures.js';

const DATA_DIR = '/Users/testuser/Zotero';

/** Every attachment resolves to bytes, hashed from its path so hashes stay stable. */
const allFilesPresent: FileProbe = (path) =>
  Promise.resolve({ byteSize: path.length * 1000, contentHash: `sha256:${path.length}` });

const noFilesPresent: FileProbe = () => Promise.resolve(null);

interface Harness {
  db: WikiReaderDatabase;
  dir: string;
  importer(overrides?: { probeFile?: FileProbe; items?: unknown[] }): ZoteroImporter;
  cleanup(): void;
}

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'wr-zotero-'));
  const db = openDatabase({
    file: join(dir, 'wiki-reader.db'),
    clock: fixedClock('2026-01-01T00:00:00.000Z'),
  }).db;

  return {
    db,
    dir,
    importer(overrides = {}): ZoteroImporter {
      const client = new ZoteroLocalClient({
        fetch: fixtureFetch(overrides.items === undefined ? {} : { items: overrides.items }),
      });
      let tick = 0;
      return new ZoteroImporter(client, db, {
        dataDir: DATA_DIR,
        probeFile: overrides.probeFile ?? allFilesPresent,
        nowMs: () => (tick += 5),
      });
    },
    cleanup(): void {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('[M04] Zotero import through the local API', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });
  afterEach(() => {
    harness.cleanup();
  });

  it('[M04] imports recorded library items into documents with files, tags and collections', async () => {
    const summary = await harness.importer().import();
    const { db } = harness;

    expect(summary.itemsSeen).toBe(topItems().length);
    expect(summary.documentsCreated).toBe(topItems().length);
    expect(summary.documentsUpdated).toBe(0);
    expect(summary.documentsUnchanged).toBe(0);

    const page = db.library.list({ limit: 100 });
    expect(page.total).toBe(topItems().length);

    // The neighbor-joining paper: two PDFs, one HTML snapshot, one linked_url bookmark.
    const nj = page.items.find((i) => i.document.title.startsWith('The neighbor-joining method'));
    expect(nj).toBeDefined();
    if (nj === undefined) throw new Error('imported item missing');

    expect(nj.document.docType).toBe('pdf');
    expect(nj.document.source).toBe('zotero');
    expect(nj.document.authors.map((a) => a.family)).toEqual(['Saitou', 'Nei']);
    // The bookmark has no bytes, so it must not become a file row.
    expect(nj.files).toHaveLength(3);
    expect(nj.files.filter((f) => f.role === 'primary')).toHaveLength(1);
    expect(nj.files.filter((f) => f.mimeType === 'application/pdf')).toHaveLength(2);
    expect(nj.collectionIds.length).toBeGreaterThan(0);

    // Renderer-facing file refs carry a protocol URL and never a filesystem path.
    for (const file of nj.files) {
      expect(file.url.startsWith('rrfile://')).toBe(true);
      expect(file).not.toHaveProperty('path');
    }

    expect(summary.filesLinked).toBeGreaterThan(0);
    expect(summary.collectionsImported).toBeGreaterThan(0);
    expect(db.collections.list().length).toBeGreaterThan(0);
  });

  it('[M04] records Zotero keys in external_references, never as internal ids', async () => {
    await harness.importer().import();
    const { db } = harness;

    const reference = db.externalReferences.find('zotero', 'document', 'QIQE79VI');
    expect(reference).not.toBeNull();
    if (reference === null) throw new Error('missing external reference');

    // The internal id is minted, not borrowed from Zotero.
    expect(reference.entityId).not.toBe('QIQE79VI');
    expect(reference.entityId.startsWith('doc_')).toBe(true);
    expect(reference.externalVersion).toBeTypeOf('number');

    const document = db.documents.getById(reference.entityId);
    expect(document).not.toBeNull();
    expect(document?.id).not.toBe('QIQE79VI');
  });

  it('[M04] queues one text-extraction job per PDF-bearing document', async () => {
    const summary = await harness.importer().import();
    const counts = harness.db.jobs.counts();

    expect(summary.extractionJobsQueued).toBeGreaterThan(0);
    expect(counts.queued).toBe(summary.extractionJobsQueued);

    // Documents whose only attachment is HTML must not queue PDF extraction.
    const pdfDocuments = harness.db.library
      .list({ limit: 100 })
      .items.filter((i) => i.document.docType === 'pdf');
    expect(summary.extractionJobsQueued).toBe(pdfDocuments.length);
  });

  it('[M04] reports missing attachment bytes as warnings instead of dropping them', async () => {
    const summary = await harness.importer({ probeFile: noFilesPresent }).import();

    expect(summary.filesLinked).toBe(0);
    expect(summary.filesMissing).toBeGreaterThan(0);
    expect(summary.warnings.length).toBe(summary.filesMissing);
    expect(summary.warnings.some((w) => w.includes('file missing on disk'))).toBe(true);

    // The documents still import: metadata is useful even when the bytes are unsynced.
    expect(summary.documentsCreated).toBe(topItems().length);
  });

  it('[M04] names a failed item without putting the error text in the response', async () => {
    // `warnings` is ordinary response data, so it never passes through `toIpcError` — the
    // sanitisation boundary that exists because a thrown message routinely names a
    // filesystem path. This is the shape of message a real EACCES produces.
    const leakyProbe: FileProbe = (path) => {
      throw new Error(`EACCES: permission denied, open '${path}'`);
    };

    const summary = await harness.importer({ probeFile: leakyProbe }).import();

    expect(summary.warnings.length).toBeGreaterThan(0);
    expect(summary.warnings.some((w) => w.includes('import failed'))).toBe(true);
    // The item key is the whole point of the warning, so it must still be there.
    expect(summary.warnings.every((w) => /^item [A-Z0-9]+: /.test(w))).toBe(true);
    // And nothing about the machine it ran on.
    expect(summary.warnings.some((w) => w.includes(DATA_DIR))).toBe(false);
    expect(summary.warnings.some((w) => w.includes('EACCES'))).toBe(false);
  });

  it('[M04] reports import progress through to completion', async () => {
    const seen: ImportProgress[] = [];
    const client = new ZoteroLocalClient({ fetch: fixtureFetch() });
    const importer = new ZoteroImporter(client, harness.db, {
      dataDir: DATA_DIR,
      probeFile: allFilesPresent,
      onProgress: (p) => seen.push(p),
    });
    await importer.import();

    expect(seen.some((p) => p.phase === 'collections')).toBe(true);
    expect(seen.filter((p) => p.phase === 'items')).toHaveLength(topItems().length);
    expect(seen.at(-1)?.phase).toBe('done');
  });
});

describe('[T03] duplicate-import prevention', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });
  afterEach(() => {
    harness.cleanup();
  });

  it('[T03] importing the same library twice creates no duplicate documents or files', async () => {
    const first = await harness.importer().import();
    const afterFirst = harness.db.library.list({ limit: 100 });
    const fileCountAfterFirst = afterFirst.items.reduce((n, i) => n + i.files.length, 0);

    const second = await harness.importer().import();
    const afterSecond = harness.db.library.list({ limit: 100 });
    const fileCountAfterSecond = afterSecond.items.reduce((n, i) => n + i.files.length, 0);

    expect(first.documentsCreated).toBeGreaterThan(0);
    expect(second.documentsCreated).toBe(0);
    // Unchanged Zotero versions are skipped rather than rewritten.
    expect(second.documentsUnchanged).toBe(first.documentsCreated);

    expect(afterSecond.total).toBe(afterFirst.total);
    expect(fileCountAfterSecond).toBe(fileCountAfterFirst);

    // Exactly one external reference per Zotero item key.
    const references = harness.db.sqlite
      .prepare(
        `SELECT external_key, COUNT(*) AS n FROM external_references
          WHERE entity_type = 'document' GROUP BY external_key HAVING n > 1`,
      )
      .all();
    expect(references).toEqual([]);
  });

  it('[T03] re-import updates in place when the Zotero version advances', async () => {
    await harness.importer().import();
    const before = harness.db.externalReferences.find('zotero', 'document', 'QIQE79VI');
    if (before === null) throw new Error('missing reference');

    // Simulate the user renaming the item in Zotero: same key, higher version.
    const edited = topItems().map((item) =>
      item.data.key === 'QIQE79VI'
        ? {
            ...item,
            version: item.data.version + 1,
            data: { ...item.data, version: item.data.version + 1, title: 'Renamed upstream' },
          }
        : item,
    );

    const second = await harness.importer({ items: edited }).import();
    expect(second.documentsUpdated).toBe(1);
    expect(second.documentsCreated).toBe(0);

    const after = harness.db.externalReferences.find('zotero', 'document', 'QIQE79VI');
    // Same internal document, new content — not a second copy.
    expect(after?.entityId).toBe(before.entityId);
    expect(harness.db.documents.getById(before.entityId)?.title).toBe('Renamed upstream');
    expect(harness.db.library.list({ limit: 100 }).total).toBe(topItems().length);
  });

  it('[T03] force re-reads unchanged items without duplicating them', async () => {
    const first = await harness.importer().import();
    const forced = await harness.importer().import({ force: true });

    expect(forced.documentsUnchanged).toBe(0);
    expect(forced.documentsUpdated).toBe(first.documentsCreated);
    expect(forced.documentsCreated).toBe(0);
    expect(harness.db.library.list({ limit: 100 }).total).toBe(topItems().length);
  });

  it('[T03] the same file path is one row no matter how often it is imported', async () => {
    await harness.importer().import();
    await harness.importer().import({ force: true });

    const duplicates = harness.db.sqlite
      .prepare('SELECT path, COUNT(*) AS n FROM document_files GROUP BY path HAVING n > 1')
      .all();
    expect(duplicates).toEqual([]);
  });
});

/**
 * Scoped import (criterion W12).
 *
 * The recorded library has two disjoint groups of items — five under `m26-sprint-wiki`, two
 * filed under subcollections of `Past Projects` — and one preprint in no collection at all.
 * That shape is what makes the assertions here real: scoping to one collection has to leave
 * the other five out *and* leave the unfiled item out, and importing the second collection
 * afterwards has to end with both groups present.
 */
describe('[W12] import scoped to a collection', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });
  afterEach(() => {
    harness.cleanup();
  });

  /** The Zotero keys of the documents currently in the library. */
  function importedKeys(): string[] {
    return harness.db.library
      .list({ limit: 100 })
      .items.map((item) => {
        const reference = harness.db.externalReferences
          .listForEntity('document', item.document.id)
          .find((row) => row.provider === ZOTERO_PROVIDER);
        if (reference === undefined) throw new Error(`no zotero key for ${item.document.id}`);
        return reference.externalKey;
      })
      .sort();
  }

  it('[W12] imports only the items in the named collection', async () => {
    const summary = await harness.importer().import({ collection: 'm26-sprint-wiki' });

    expect(summary.collectionScope).toBe('m26-sprint-wiki');
    expect(summary.itemsSeen).toBe(5);
    expect(summary.documentsCreated).toBe(5);
    expect(importedKeys()).toEqual(
      ['VWPWR9BS', 'AL2XD8VY', 'TQKPJY5H', 'PB3MVTT6', 'VS7MANRS'].sort(),
    );
    // The unfiled preprint and the phylogenetics papers are in the library, not in scope.
    expect(importedKeys()).not.toContain('438MK4WU');
    expect(importedKeys()).not.toContain('QU9C7W2S');
  });

  it('[W12] importing a second collection adds to the first rather than replacing it', async () => {
    await harness.importer().import({ collection: 'm26-sprint-wiki' });
    const second = await harness.importer().import({ collection: 'CA-Evolution' });

    expect(second.itemsSeen).toBe(2);
    expect(second.documentsCreated).toBe(2);
    // Both groups, and still nothing that was never in scope.
    expect(importedKeys()).toEqual(
      ['VWPWR9BS', 'AL2XD8VY', 'TQKPJY5H', 'PB3MVTT6', 'VS7MANRS', 'QU9C7W2S', 'QIQE79VI'].sort(),
    );
    expect(importedKeys()).not.toContain('438MK4WU');
  });

  it('[W12] re-importing the same collection updates in place', async () => {
    await harness.importer().import({ collection: 'm26-sprint-wiki' });
    const again = await harness.importer().import({ collection: 'm26-sprint-wiki' });

    expect(again.documentsCreated).toBe(0);
    expect(again.documentsUnchanged).toBe(5);
    expect(importedKeys()).toHaveLength(5);
  });

  it('[W12] a parent collection covers the items of its subcollections', async () => {
    const summary = await harness.importer().import({ collection: 'Past Projects' });

    // 'Past Projects' holds no items directly; both papers are filed under its children.
    expect(summary.itemsSeen).toBe(2);
    expect(importedKeys()).toEqual(['QU9C7W2S', 'QIQE79VI'].sort());
  });

  it('[W12] an unknown collection name fails without importing anything', async () => {
    await expect(harness.importer().import({ collection: 'Nonexistent' })).rejects.toThrow(
      /Nonexistent/,
    );
    expect(harness.db.library.list({ limit: 100 }).total).toBe(0);
  });

  it('[W12] an import with no collection still pulls the whole library', async () => {
    const summary = await harness.importer().import();

    expect(summary.collectionScope).toBeNull();
    expect(summary.itemsSeen).toBe(topItems().length);
    expect(importedKeys()).toContain('438MK4WU');
  });
});
