/**
 * Choosing the notes folder, and what happens to the notes from the old one (criterion C02).
 *
 * The corpus root used to be main-process configuration and nothing else: an environment
 * variable read once at startup, with no way to change it from inside the app. When it moved —
 * because the variable was set for one experiment and then unset, or because the folder was
 * renamed — the documents ingested from the old folder stayed in the library pointing at files
 * `rrfile://` now refuses, so the notes list filled with rows that answered every click with
 * `403 Forbidden`. That is the protocol working; the bug is the rows.
 *
 * So this drives the real channels over a real database and two real folders on disk. The only
 * thing standing in for production is the directory dialog itself, which is injected — the
 * sequence underneath it (remember, swap the allow-list, purge, re-import) is the part with
 * the behaviour in it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServices, type AppServices } from '../../apps/desktop/src/main/services.js';
import { createHandlers } from '../../apps/desktop/src/main/handlers.js';
import { dispatch } from '../../apps/desktop/src/main/router.js';
import { silentLogger } from '../../apps/desktop/src/main/logger.js';
import { NOTES_FOLDER_SETTING } from '../../apps/desktop/src/main/notes-folder.js';
import type { IpcResult } from '@wr/shared-types';

let dir: string;
let databasePath: string;
let folderA: string;
let folderB: string;
let services: AppServices;
/** What the injected dialog will answer next. */
let dialogAnswer: string | null;

function seed(folder: string, files: Record<string, string>): void {
  mkdirSync(folder, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(folder, name), body, 'utf8');
  }
}

function open(markdownRoot: string): AppServices {
  return createTestServices({
    databasePath,
    zoteroDataDir: join(dir, 'Zotero'),
    markdownRoot,
    chooseDirectory: () => Promise.resolve(dialogAnswer),
  });
}

/** Send a request the way the renderer would: through the router and its validation. */
async function send(channel: string, request: unknown = {}): Promise<IpcResult<unknown>> {
  return dispatch(createHandlers(services), channel, request, silentLogger);
}

/** Unwrap a successful result, failing loudly on the error envelope. */
function value<T>(result: IpcResult<unknown>): T {
  if (!result.ok) throw new Error(`ipc failed: ${result.error.code} ${result.error.message}`);
  return result.value as T;
}

/** The titles the notes section of the library currently lists. */
function noteTitles(): string[] {
  return services.db.documents
    .list({ source: 'corpus', limit: 100 })
    .items.map((document) => document.title)
    .sort();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-notes-folder-'));
  databasePath = join(dir, 'wiki-reader.db');
  folderA = join(dir, 'old-wiki');
  folderB = join(dir, 'new-wiki');
  seed(folderA, {
    'attention.md': '# Attention\n\nNotes on the old folder.\n',
    'sparsity.md': '# Sparsity\n\nMore of the old folder.\n',
  });
  seed(folderB, { 'features.md': '# Features\n\nThe folder in use now.\n' });
  dialogAnswer = folderB;
  services = open(folderA);
});

afterEach(() => {
  services.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the notes folder', () => {
  it('[C02] is chosen in-app, and documents from a folder no longer in use are purged', async () => {
    value(await send('corpus:import', {}));
    expect(noteTitles()).toEqual(['Attention', 'Sparsity']);

    const before = value<{ folderName: string; chosenInApp: boolean; noteCount: number }>(
      await send('corpus:folder'),
    );
    expect(before).toMatchObject({ folderName: 'old-wiki', chosenInApp: false, noteCount: 2 });

    const change = value<{
      changed: boolean;
      folderName: string;
      chosenInApp: boolean;
      purged: number;
      documentsCreated: number;
    }>(await send('corpus:chooseFolder'));

    expect(change.changed).toBe(true);
    expect(change.folderName).toBe('new-wiki');
    expect(change.chosenInApp).toBe(true);
    expect(change.purged).toBe(2);
    expect(change.documentsCreated).toBe(1);

    // The old folder's notes are gone from the library, and the new folder's are in it.
    expect(noteTitles()).toEqual(['Features']);
  });

  it('[C02] purges rather than tombstones: the old rows do not come back', async () => {
    value(await send('corpus:import', {}));
    const oldIds = services.db.documents
      .list({ source: 'corpus', limit: 100 })
      .items.map((document) => document.id);
    expect(oldIds).toHaveLength(2);

    value(await send('corpus:chooseFolder'));

    // A soft delete would satisfy the list above while leaving every row — and its file rows,
    // its chunks and its links — in place, so the notes would reappear the moment anything
    // listed deleted documents. Nothing about the old folder may survive.
    const remaining = services.db.documents.list({
      source: 'corpus',
      includeDeleted: true,
      limit: 100,
    });
    expect(remaining.items.map((document) => document.id)).not.toContain(oldIds[0]);
    expect(remaining.total).toBe(1);
    for (const id of oldIds) {
      expect(services.db.documents.getById(id)).toBeNull();
      expect(services.db.files.listByDocument(id)).toHaveLength(0);
    }
  });

  it('[C02] remembers the folder across a restart, outranking the configured one', async () => {
    value(await send('corpus:import', {}));
    value(await send('corpus:chooseFolder'));

    // Restart the whole service container over the same database, configured — as the
    // environment still is — with the *old* folder. A choice made in the app has to win, or
    // it was not a choice.
    services.close();
    services = open(folderA);

    const status = value<{ folderName: string; chosenInApp: boolean; noteCount: number }>(
      await send('corpus:folder'),
    );
    expect(status.folderName).toBe('new-wiki');
    expect(status.chosenInApp).toBe(true);
    expect(noteTitles()).toEqual(['Features']);
    expect(services.db.settings.get(NOTES_FOLDER_SETTING)).toEqual({ path: folderB });
  });

  it('[C02] leaves everything alone when the dialog is cancelled', async () => {
    value(await send('corpus:import', {}));
    dialogAnswer = null;

    const change = value<{ changed: boolean; purged: number; folderName: string }>(
      await send('corpus:chooseFolder'),
    );
    expect(change.changed).toBe(false);
    expect(change.purged).toBe(0);
    expect(change.folderName).toBe('old-wiki');
    expect(noteTitles()).toEqual(['Attention', 'Sparsity']);
  });

  it('[C02] refuses a folder that is not a directory, and changes nothing', async () => {
    value(await send('corpus:import', {}));
    // The only callers are the dialog and the stored setting, so this is the hand-edited-row
    // case: it must decline rather than purge a library against a folder that cannot be read.
    dialogAnswer = join(folderA, 'attention.md');

    const change = value<{ changed: boolean; purged: number }>(await send('corpus:chooseFolder'));
    expect(change.changed).toBe(false);
    expect(change.purged).toBe(0);
    expect(noteTitles()).toEqual(['Attention', 'Sparsity']);
  });

  it('[C02] never puts a filesystem path in the response', async () => {
    value(await send('corpus:import', {}));
    const status = JSON.stringify(value(await send('corpus:folder')));
    const change = JSON.stringify(value(await send('corpus:chooseFolder')));
    // The renderer addresses bytes by file id and must not be able to learn — or send back —
    // where anything lives. A folder *name* is not a path: nothing can be opened with it.
    for (const payload of [status, change]) {
      expect(payload).not.toContain(dir);
      expect(payload).not.toContain(folderA);
      expect(payload).not.toContain(folderB);
    }
  });
});
