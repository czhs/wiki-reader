/**
 * Scoped Zotero import, driven through the channel the app actually calls (criterion W12).
 *
 * `packages/zotero-adapter/test/importer.test.ts` already covers the scoping *logic* against
 * the recorded fixtures, but it constructs `ZoteroImporter` directly. That leaves the shipping
 * path — the `zotero:import` contract, its zod validation, and the handler that forwards
 * `collection` to the importer — asserted by nothing: the handler could drop `collection` on
 * the floor and import the whole library, and every `[W12]` test would still pass.
 *
 * So this suite goes in the other door. It sends the request the way the renderer would, over
 * the real router into a real database, and asserts on what landed in the library.
 *
 * The fixtures are reached by injecting `zoteroFetch` into the services container. Zotero is
 * not running here, and a route the fake API serves but the real one might not is exactly the
 * fake data path the rules forbid — so the fake answers the same recorded JSON the adapter's
 * own suite uses, and nothing about the request shape is invented.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServices, type AppServices } from '../../apps/desktop/src/main/services.js';
import { createHandlers } from '../../apps/desktop/src/main/handlers.js';
import { dispatch } from '../../apps/desktop/src/main/router.js';
import { silentLogger } from '../../apps/desktop/src/main/logger.js';
import { fixtureFetch } from '../../packages/zotero-adapter/test/fake-api.js';
import { ZOTERO_PROVIDER } from '@wr/zotero-adapter';

let dir: string;
let services: AppServices;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-zotero-import-'));
  services = createTestServices({
    databasePath: join(dir, 'wiki-reader.db'),
    zoteroDataDir: join(dir, 'Zotero'),
    zoteroFetch: fixtureFetch(),
  });
});

afterEach(() => {
  services.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Send a request the way the renderer would: through the router and its validation. */
async function attempt(request: unknown): Promise<ReturnType<typeof dispatch>> {
  return dispatch(createHandlers(services), 'zotero:import', request, silentLogger);
}

/** The Zotero item keys of the documents currently in the library. */
function importedKeys(): string[] {
  return services.db.library
    .list({ limit: 100 })
    .items.map((item) => {
      const reference = services.db.externalReferences
        .listForEntity('document', item.document.id)
        .find((row) => row.provider === ZOTERO_PROVIDER);
      if (reference === undefined) throw new Error(`no zotero key for ${item.document.id}`);
      return reference.externalKey;
    })
    .sort();
}

describe('scoped Zotero import over the router', () => {
  it('[W12] imports only the named collection when asked over the channel', async () => {
    const result = await attempt({ collection: 'm26-sprint-wiki' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The handler has to forward the scope; if it dropped it, the unfiled preprint and the
    // phylogenetics papers would be here too.
    expect(importedKeys()).toEqual(
      ['VWPWR9BS', 'AL2XD8VY', 'TQKPJY5H', 'PB3MVTT6', 'VS7MANRS'].sort(),
    );
    expect(importedKeys()).not.toContain('438MK4WU');
  });

  it('[W12] a second collection over the channel adds to the first', async () => {
    const first = await attempt({ collection: 'm26-sprint-wiki' });
    expect(first.ok).toBe(true);
    const second = await attempt({ collection: 'CA-Evolution' });
    expect(second.ok).toBe(true);

    // Both groups present: a replace would have left only the second.
    expect(importedKeys()).toEqual(
      ['VWPWR9BS', 'AL2XD8VY', 'TQKPJY5H', 'PB3MVTT6', 'VS7MANRS', 'QU9C7W2S', 'QIQE79VI'].sort(),
    );
  });

  it('[W12] refuses a malformed collection before importing anything', async () => {
    // Not a string, and an empty string: both are rejected by the contract, not the importer.
    for (const collection of [42, '']) {
      const result = await attempt({ collection });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_REQUEST');
    }
    expect(importedKeys()).toEqual([]);
  });

  it('[W12] reports an unknown collection as an error envelope, importing nothing', async () => {
    const result = await attempt({ collection: 'no-such-collection' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    expect(importedKeys()).toEqual([]);
  });
});

/**
 * Picking collections, and the picks outliving the process (criterion C01).
 *
 * The E2E spec drives the picker a person actually uses. This is the half that spec cannot
 * see: that an import which names no scope of its own is narrowed by what was picked, and
 * that the narrowing survives the service container being torn down and rebuilt. Without it,
 * "the picks are remembered" could be satisfied by a checkbox that stays ticked and changes
 * nothing.
 */
describe('remembered import scope', () => {
  const scope = async (request: unknown): Promise<ReturnType<typeof dispatch>> =>
    dispatch(createHandlers(services), 'zotero:setImportScope', request, silentLogger);

  it('[C01] scopes an import that names no collection of its own', async () => {
    const saved = await scope({ collections: ['m26-sprint-wiki'] });
    expect(saved.ok).toBe(true);

    const result = await attempt({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { collectionScope: string | null }).collectionScope).toBe(
        'm26-sprint-wiki',
      );
    }
    expect(importedKeys()).not.toContain('438MK4WU');
    expect(importedKeys()).toEqual(
      ['VWPWR9BS', 'AL2XD8VY', 'TQKPJY5H', 'PB3MVTT6', 'VS7MANRS'].sort(),
    );
  });

  it('[C01] covers the union of several picks in one pass', async () => {
    await scope({ collections: ['m26-sprint-wiki', 'CA-Evolution'] });

    const result = await attempt({});
    expect(result.ok).toBe(true);
    // One import, not one per collection: the totals have to be over the union, and a paper
    // filed in both may be seen only once.
    if (result.ok) {
      const summary = result.value as { itemsSeen: number; collectionScope: string | null };
      expect(summary.collectionScope).toBe('m26-sprint-wiki, CA-Evolution');
      expect(summary.itemsSeen).toBe(7);
    }
    expect(importedKeys()).toEqual(
      ['VWPWR9BS', 'AL2XD8VY', 'TQKPJY5H', 'PB3MVTT6', 'VS7MANRS', 'QU9C7W2S', 'QIQE79VI'].sort(),
    );
  });

  it('[C01] remembers the picks across a restart', async () => {
    await scope({ collections: ['CA-Evolution'] });

    // Tear the whole container down and build another over the same database file, the way a
    // relaunch does. A pick held in renderer state or in a field on the importer dies here.
    services.close();
    services = createTestServices({
      databasePath: join(dir, 'wiki-reader.db'),
      zoteroDataDir: join(dir, 'Zotero'),
      zoteroFetch: fixtureFetch(),
    });

    const remembered = await dispatch(
      createHandlers(services),
      'zotero:getImportScope',
      {},
      silentLogger,
    );
    expect(remembered.ok).toBe(true);
    if (remembered.ok) {
      expect((remembered.value as { collections: string[] }).collections).toEqual(['CA-Evolution']);
    }

    const result = await attempt({});
    expect(result.ok).toBe(true);
    expect(importedKeys()).toEqual(['QU9C7W2S', 'QIQE79VI'].sort());
  });

  it('[C01] an explicitly empty pick list means the whole library, not nothing', async () => {
    await scope({ collections: ['m26-sprint-wiki'] });
    await scope({ collections: [] });

    const result = await attempt({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { collectionScope: string | null }).collectionScope).toBeNull();
    }
    // The unfiled preprint is in none of the collections, so its presence is what says the
    // scope was actually cleared rather than remembered.
    expect(importedKeys()).toContain('438MK4WU');
  });

  it('[C01] lists the collections to pick from even when Zotero is not running', async () => {
    // The picker's fallback. Zotero serves its local API only while open, and a picker that
    // is empty whenever it is closed cannot even show what the current scope is.
    await attempt({ collection: 'm26-sprint-wiki' });

    const offline = createTestServices({
      databasePath: join(dir, 'wiki-reader.db'),
      zoteroDataDir: join(dir, 'Zotero'),
      zoteroFetch: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:23119')),
    });
    try {
      const listed = await dispatch(
        createHandlers(offline),
        'zotero:listCollections',
        {},
        silentLogger,
      );
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const value = listed.value as {
        live: boolean;
        message: string;
        collections: { name: string; label: string; ambiguous: boolean }[];
      };
      expect(value.live).toBe(false);
      expect(value.message).toMatch(/not running/i);
      expect(value.collections.map((option) => option.name)).toContain('m26-sprint-wiki');
      // The breadcrumb, not the bare name: "Drafts" under three projects is three collections.
      expect(value.collections.map((option) => option.label)).toContain(
        'Past Projects / CA-Evolution',
      );
    } finally {
      offline.close();
    }
  });
});
