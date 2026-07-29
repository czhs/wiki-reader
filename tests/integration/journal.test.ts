/**
 * The dated research journal (criteria J01, J03).
 *
 * Every request crosses the real router into a real SQLite file, and the persistence case
 * closes the services and reopens them against the same file.
 *
 * The rule worth testing hardest is the one about blank days: an entry cleared to nothing is
 * *deleted*, not stored as an empty string. "No entry" and "an empty entry" are the same
 * fact, and a calendar that could tell them apart would be showing a difference that does not
 * exist — so the assertion is that the row is gone and that no other path can put an empty
 * one back.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcChannel, IpcRequest, IpcResponse } from '@wr/shared-types';
import { createTestServices, type AppServices } from '../../apps/desktop/src/main/services.js';
import { createHandlers } from '../../apps/desktop/src/main/handlers.js';
import { dispatch } from '../../apps/desktop/src/main/router.js';
import { silentLogger } from '../../apps/desktop/src/main/logger.js';

class Workspace {
  readonly dir: string;
  readonly databasePath: string;
  private current: AppServices;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'wr-journal-'));
    this.databasePath = join(this.dir, 'wiki-reader.db');
    this.current = this.open();
  }

  private open(): AppServices {
    return createTestServices({
      databasePath: this.databasePath,
      zoteroDataDir: join(this.dir, 'zotero'),
    });
  }

  get services(): AppServices {
    return this.current;
  }

  restart(): void {
    this.current.close();
    this.current = this.open();
  }

  async call<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
    const result = await dispatch(createHandlers(this.current), channel, request, silentLogger);
    if (!result.ok) {
      throw new Error(`ipc ${channel} failed: ${result.error.code} ${result.error.message}`);
    }
    return result.value as IpcResponse<K>;
  }

  async attempt(channel: string, request: unknown): Promise<ReturnType<typeof dispatch>> {
    return dispatch(createHandlers(this.current), channel, request, silentLogger);
  }

  dispose(): void {
    this.current.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

let workspace: Workspace;

beforeEach(() => {
  workspace = new Workspace();
});

afterEach(() => {
  workspace.dispose();
});

const MONDAY = '2026-07-20';
const TUESDAY = '2026-07-21';
const THURSDAY = '2026-07-23';

/**
 * Today as the calendar means it: a local day, not a UTC one.
 *
 * Derived here rather than written down, because the day a temporary library is created is
 * the day the test runs — and because a UTC slice of the timestamp would disagree with it by
 * one day for most of the world.
 */
function todayLocal(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

const ENTRY = [
  '## What I did',
  '',
  'Ran the induction-head sweep over the VLA checkpoints. Layer 14 head 3 looks like a copier.',
].join('\n');

describe('the research journal', () => {
  it('[J01] writes a dated entry, reads it back, and keeps it across a restart', async () => {
    const written = await workspace.call('journal:write', { date: MONDAY, markdown: ENTRY });
    expect(written.entry?.markdown).toBe(ENTRY);

    workspace.restart();

    const { entry } = await workspace.call('journal:get', { date: MONDAY });
    expect(entry).not.toBeNull();
    expect(entry?.date).toBe(MONDAY);
    // The markdown comes back as source, verbatim, newlines and all.
    expect(entry?.markdown).toBe(ENTRY);

    // A day nobody wrote on answers with nothing rather than an empty entry.
    expect((await workspace.call('journal:get', { date: TUESDAY })).entry).toBeNull();
  });

  it('[J01] one entry per day: writing again revises that day rather than adding another', async () => {
    await workspace.call('journal:write', { date: MONDAY, markdown: 'first pass' });
    await workspace.call('journal:write', { date: MONDAY, markdown: 'second pass' });
    await workspace.call('journal:write', { date: THURSDAY, markdown: 'thursday' });

    workspace.restart();

    const { dates } = await workspace.call('journal:loggedDates', {});
    expect(dates).toEqual([MONDAY, THURSDAY]);
    expect((await workspace.call('journal:get', { date: MONDAY })).entry?.markdown).toBe(
      'second pass',
    );
  });

  it('[J01] a day cleared to nothing is deleted, not stored empty', async () => {
    await workspace.call('journal:write', { date: MONDAY, markdown: ENTRY });

    const cleared = await workspace.call('journal:write', { date: MONDAY, markdown: '   \n  ' });
    expect(cleared.entry).toBeNull();

    workspace.restart();

    expect((await workspace.call('journal:get', { date: MONDAY })).entry).toBeNull();
    // Not "an entry that reads as empty" — no row at all, so the calendar cannot mark it.
    expect((await workspace.call('journal:loggedDates', {})).dates).toEqual([]);
    expect(
      workspace.services.db.sqlite
        .prepare('SELECT COUNT(*) AS n FROM journal_entries')
        .get(),
    ).toEqual({ n: 0 });

    // And the schema refuses an empty entry however it is written, so no other path can put
    // one back and make an unlogged day look logged.
    expect(() =>
      workspace.services.db.sqlite
        .prepare(
          `INSERT INTO journal_entries (date, markdown, created_at, updated_at)
           VALUES (?, '', ?, ?)`,
        )
        .run(MONDAY, '2026-07-20T09:00:00.000Z', '2026-07-20T09:00:00.000Z'),
    ).toThrow();
  });

  it('[N10] the calendar starts when the project did, not when the first entry was written', async () => {
    // Nothing written yet, and the calendar still has a beginning: the day this library was
    // made. A start derived from the entries would be null here, and the journal would have
    // no days at all until someone wrote one.
    const madeToday = todayLocal();
    const cold = await workspace.call('journal:loggedDates', {});
    expect(cold.dates).toEqual([]);
    expect(cold.projectStart).toBe(madeToday);

    // An entry older than this database — backfilled, or carried over from a journal kept
    // elsewhere — moves the start back rather than falling off the front of the calendar.
    await workspace.call('journal:write', { date: MONDAY, markdown: ENTRY });
    expect((await workspace.call('journal:loggedDates', {})).projectStart).toBe(MONDAY);

    // A later entry does not move it forward again: the project still began when it began.
    await workspace.call('journal:write', { date: THURSDAY, markdown: 'thursday' });
    expect((await workspace.call('journal:loggedDates', {})).projectStart).toBe(MONDAY);

    workspace.restart();
    expect((await workspace.call('journal:loggedDates', {})).projectStart).toBe(MONDAY);
  });

  it('[J01] refuses something that is not a calendar day', async () => {
    const result = await workspace.attempt('journal:write', {
      date: '20 July 2026',
      markdown: ENTRY,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_REQUEST');
  });

  it('[J03] links an entry to the question it advances', async () => {
    const { question } = await workspace.call('question:create', {
      title: 'Do induction heads appear in VLAs?',
    });
    const other = await workspace.call('question:create', {
      title: 'Does the J-space latent decode to language?',
    });
    await workspace.call('journal:write', { date: MONDAY, markdown: ENTRY });

    await workspace.call('journal:advancesQuestion', { date: MONDAY, questionId: question.id });

    workspace.restart();

    // The same table, the same reference query as everything else in the wiki.
    const { links } = await workspace.call('link:findReferences', {
      entityType: 'journal',
      entityId: MONDAY,
      direction: 'outgoing',
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.type).toBe('journal-entry-advances-question');
    expect(links[0]?.targetId).toBe(question.id);
    expect(links[0]?.broken).toBe(false);
    expect(links[0]?.otherTitle).toBe('Do induction heads appear in VLAs?');

    // And the question can say which days moved it forward, which is the direction the
    // reader actually asks in.
    const incoming = await workspace.call('link:findReferences', {
      entityType: 'question',
      entityId: question.id,
      direction: 'incoming',
    });
    expect(incoming.links.map((link) => link.sourceId)).toEqual([MONDAY]);
    const untouched = await workspace.call('link:findReferences', {
      entityType: 'question',
      entityId: other.question.id,
      direction: 'incoming',
    });
    expect(untouched.links).toEqual([]);
  });

  it('[J03] refuses a link from a day with no entry, or to a question that is not there', async () => {
    const { question } = await workspace.call('question:create', {
      title: 'Do induction heads appear in VLAs?',
    });

    const noEntry = await workspace.attempt('journal:advancesQuestion', {
      date: THURSDAY,
      questionId: question.id,
    });
    expect(noEntry.ok).toBe(false);
    if (!noEntry.ok) expect(noEntry.error.code).toBe('NOT_FOUND');

    await workspace.call('journal:write', { date: THURSDAY, markdown: ENTRY });
    const noQuestion = await workspace.attempt('journal:advancesQuestion', {
      date: THURSDAY,
      questionId: 'qst_00000000000000000000000000',
    });
    expect(noQuestion.ok).toBe(false);
    if (!noQuestion.ok) expect(noQuestion.error.code).toBe('NOT_FOUND');

    const { links } = await workspace.call('link:findReferences', {
      entityType: 'journal',
      entityId: THURSDAY,
      direction: 'outgoing',
    });
    expect(links).toEqual([]);
  });
});
