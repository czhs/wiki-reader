/**
 * A notebook's journal (criteria J01, J03, N10, P02, P03).
 *
 * Every request crosses the real router into a real SQLite file, and the persistence case
 * closes the services and reopens them against the same file.
 *
 * Two rules are tested hardest, because both are the kind a plausible refactor breaks:
 *
 * - **A day belongs to its notebook** (`P02`). The same date written under two notebooks is
 *   two days, not one, and neither can be read from the other. There is no channel that can
 *   read or write a day without saying whose it is, which is the part that keeps the global
 *   stream from coming back by accident.
 * - **A blank day is deleted**, not stored as an empty string. "No entry" and "an empty entry"
 *   are the same fact, and a calendar that could tell them apart would be showing a difference
 *   that does not exist — so the assertion is that the row is gone and that no other path can
 *   put an empty one back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { journalEntityId } from '@wr/shared-types';
import { IntegrationWorkspace } from './support/workspace.js';

class Workspace extends IntegrationWorkspace {
  constructor() {
    super('wr-journal-');
  }

  /** A notebook to write days under. Returns its id, which is what every call needs. */
  async notebook(title: string): Promise<string> {
    const { question } = await this.call('question:create', { title });
    return question.id;
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

describe('a notebook’s journal', () => {
  it('[J01] writes a dated entry, reads it back, and keeps it across a restart', async () => {
    const notebookId = await workspace.notebook('Do induction heads appear in VLAs?');
    const written = await workspace.call('journal:write', {
      notebookId,
      date: MONDAY,
      markdown: ENTRY,
    });
    expect(written.entry?.markdown).toBe(ENTRY);

    workspace.restart();

    const { entry } = await workspace.call('journal:get', { notebookId, date: MONDAY });
    expect(entry).not.toBeNull();
    expect(entry?.date).toBe(MONDAY);
    expect(entry?.notebookId).toBe(notebookId);
    // The markdown comes back as source, verbatim, newlines and all.
    expect(entry?.markdown).toBe(ENTRY);

    // A day nobody wrote on answers with nothing rather than an empty entry.
    expect((await workspace.call('journal:get', { notebookId, date: TUESDAY })).entry).toBeNull();
  });

  it('[J01] one entry per day: writing again revises that day rather than adding another', async () => {
    const notebookId = await workspace.notebook('Do induction heads appear in VLAs?');
    await workspace.call('journal:write', { notebookId, date: MONDAY, markdown: 'first pass' });
    await workspace.call('journal:write', { notebookId, date: MONDAY, markdown: 'second pass' });
    await workspace.call('journal:write', { notebookId, date: THURSDAY, markdown: 'thursday' });

    workspace.restart();

    const { dates } = await workspace.call('journal:loggedDates', { notebookId });
    expect(dates).toEqual([MONDAY, THURSDAY]);
    expect((await workspace.call('journal:get', { notebookId, date: MONDAY })).entry?.markdown).toBe(
      'second pass',
    );
  });

  it('[J01] a day cleared to nothing is deleted, not stored empty', async () => {
    const notebookId = await workspace.notebook('Do induction heads appear in VLAs?');
    await workspace.call('journal:write', { notebookId, date: MONDAY, markdown: ENTRY });

    const cleared = await workspace.call('journal:write', {
      notebookId,
      date: MONDAY,
      markdown: '   \n  ',
    });
    expect(cleared.entry).toBeNull();

    workspace.restart();

    expect((await workspace.call('journal:get', { notebookId, date: MONDAY })).entry).toBeNull();
    // Not "an entry that reads as empty" — no row at all, so the calendar cannot mark it.
    expect((await workspace.call('journal:loggedDates', { notebookId })).dates).toEqual([]);
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
          `INSERT INTO journal_entries (notebook_id, date, markdown, created_at, updated_at)
           VALUES (?, ?, '', ?, ?)`,
        )
        .run(notebookId, MONDAY, '2026-07-20T09:00:00.000Z', '2026-07-20T09:00:00.000Z'),
    ).toThrow();
  });

  it('[P02] a day written under one notebook is not a day in another', async () => {
    const heads = await workspace.notebook('Do induction heads appear in VLAs?');
    const latents = await workspace.notebook('Does the J-space latent decode to language?');

    await workspace.call('journal:write', { notebookId: heads, date: MONDAY, markdown: ENTRY });
    await workspace.call('journal:write', {
      notebookId: latents,
      date: MONDAY,
      markdown: 'Swept the decoder over four checkpoints.',
    });

    workspace.restart();

    // The same date in two notebooks is two entries, each with its own text. Under the old
    // global journal the second write would have overwritten the first.
    expect((await workspace.call('journal:get', { notebookId: heads, date: MONDAY })).entry?.markdown).toBe(
      ENTRY,
    );
    expect(
      (await workspace.call('journal:get', { notebookId: latents, date: MONDAY })).entry?.markdown,
    ).toBe('Swept the decoder over four checkpoints.');

    // And a day written in one is not in the other's calendar at all.
    await workspace.call('journal:write', {
      notebookId: heads,
      date: THURSDAY,
      markdown: 'thursday, heads',
    });
    expect((await workspace.call('journal:loggedDates', { notebookId: heads })).dates).toEqual([
      MONDAY,
      THURSDAY,
    ]);
    expect((await workspace.call('journal:loggedDates', { notebookId: latents })).dates).toEqual([
      MONDAY,
    ]);
    expect(
      (await workspace.call('journal:get', { notebookId: latents, date: THURSDAY })).entry,
    ).toBeNull();

    // Clearing a day clears that notebook's day and no other.
    await workspace.call('journal:write', { notebookId: heads, date: MONDAY, markdown: '' });
    expect((await workspace.call('journal:get', { notebookId: heads, date: MONDAY })).entry).toBeNull();
    expect(
      (await workspace.call('journal:get', { notebookId: latents, date: MONDAY })).entry,
    ).not.toBeNull();
  });

  it('[P02] a day cannot be written without a notebook, or under one that is not there', async () => {
    // No channel takes a bare date. The global stream cannot come back by accident, because
    // the contract itself refuses the shape it had.
    const bare = await workspace.attempt('journal:write', { date: MONDAY, markdown: ENTRY });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.code).toBe('INVALID_REQUEST');

    const orphan = await workspace.attempt('journal:write', {
      notebookId: 'qst_00000000000000000000000000',
      date: MONDAY,
      markdown: ENTRY,
    });
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) expect(orphan.error.code).toBe('NOT_FOUND');

    expect(
      workspace.services.db.sqlite.prepare('SELECT COUNT(*) AS n FROM journal_entries').get(),
    ).toEqual({ n: 0 });
  });

  it('[P02] the day and its notebook are one endpoint: a link to it says which notebook', async () => {
    const heads = await workspace.notebook('Do induction heads appear in VLAs?');
    const latents = await workspace.notebook('Does the J-space latent decode to language?');
    await workspace.call('journal:write', { notebookId: heads, date: MONDAY, markdown: ENTRY });
    await workspace.call('journal:write', {
      notebookId: latents,
      date: MONDAY,
      markdown: 'Swept the decoder.',
    });

    await workspace.call('journal:advancesNotebook', {
      notebookId: heads,
      date: MONDAY,
      advancesId: latents,
    });

    workspace.restart();

    // The edge names one day of one notebook. Addressed by date alone it would have been
    // ambiguous between the two entries written above.
    const { links } = await workspace.call('link:findReferences', {
      entityType: 'journal',
      entityId: journalEntityId(heads, MONDAY),
      direction: 'outgoing',
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.targetId).toBe(latents);

    const otherDay = await workspace.call('link:findReferences', {
      entityType: 'journal',
      entityId: journalEntityId(latents, MONDAY),
      direction: 'outgoing',
    });
    expect(otherDay.links).toEqual([]);

    // And going up from a day lands on the notebook it was written under.
    const { parent } = await workspace.call('link:getParent', {
      entityType: 'journal',
      entityId: journalEntityId(heads, MONDAY),
    });
    expect(parent?.entityType).toBe('question');
    expect(parent?.entityId).toBe(heads);
    expect(parent?.title).toBe('Do induction heads appear in VLAs?');
  });

  it('[P03] the calendar begins where the researcher says, and the date survives a restart', async () => {
    const notebookId = await workspace.notebook('Do induction heads appear in VLAs?');
    const madeToday = todayLocal();

    // Nothing set: the calendar begins when this notebook did, which is today.
    expect((await workspace.call('journal:loggedDates', { notebookId })).journalStart).toBe(
      madeToday,
    );

    // The researcher says the work started in March. Nothing in the database could have
    // known that — it is the whole reason the date is theirs to set.
    await workspace.call('question:update', { questionId: notebookId, journalStart: '2026-03-02' });

    workspace.restart();

    expect((await workspace.call('journal:loggedDates', { notebookId })).journalStart).toBe(
      '2026-03-02',
    );
    expect((await workspace.call('question:get', { questionId: notebookId })).question.journalStart).toBe(
      '2026-03-02',
    );

    // An entry older than the chosen start still wins: a day backfilled or carried over from
    // a journal kept elsewhere must not fall off the front of the calendar.
    await workspace.call('journal:write', {
      notebookId,
      date: '2026-01-06',
      markdown: 'Started reading before the notebook existed.',
    });
    expect((await workspace.call('journal:loggedDates', { notebookId })).journalStart).toBe(
      '2026-01-06',
    );

    // Cleared, the decision goes back to the app: the notebook's own beginning, or that
    // older entry, whichever is earlier.
    await workspace.call('question:update', { questionId: notebookId, journalStart: null });
    expect((await workspace.call('journal:loggedDates', { notebookId })).journalStart).toBe(
      '2026-01-06',
    );
  });

  it('[P03] each notebook begins where it begins, and one start is not another', async () => {
    const heads = await workspace.notebook('Do induction heads appear in VLAs?');
    const latents = await workspace.notebook('Does the J-space latent decode to language?');

    await workspace.call('question:update', { questionId: heads, journalStart: '2026-03-02' });

    expect((await workspace.call('journal:loggedDates', { notebookId: heads })).journalStart).toBe(
      '2026-03-02',
    );
    expect(
      (await workspace.call('journal:loggedDates', { notebookId: latents })).journalStart,
    ).toBe(todayLocal());

    // The directory reports the same answer, so the shelf and the page cannot disagree.
    const { notebooks } = await workspace.call('notebook:directory', {});
    const row = notebooks.find((candidate) => candidate.notebook.id === heads);
    expect(row?.journalStart).toBe('2026-03-02');
  });

  it('[P03] refuses a start that is not a calendar day', async () => {
    const notebookId = await workspace.notebook('Do induction heads appear in VLAs?');
    const result = await workspace.attempt('question:update', {
      questionId: notebookId,
      journalStart: '2 March 2026',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_REQUEST');
  });

  it('[N10] the calendar shows every day since the notebook began, entries or not', async () => {
    const notebookId = await workspace.notebook('Do induction heads appear in VLAs?');
    const madeToday = todayLocal();

    // Nothing written yet, and the calendar still has a beginning. A start derived from the
    // entries would be null here, and the journal would have no days at all until someone
    // wrote one.
    const cold = await workspace.call('journal:loggedDates', { notebookId });
    expect(cold.dates).toEqual([]);
    expect(cold.journalStart).toBe(madeToday);

    await workspace.call('journal:write', { notebookId, date: MONDAY, markdown: ENTRY });
    expect((await workspace.call('journal:loggedDates', { notebookId })).journalStart).toBe(MONDAY);

    // A later entry does not move it forward again: the work still began when it began.
    await workspace.call('journal:write', { notebookId, date: THURSDAY, markdown: 'thursday' });
    expect((await workspace.call('journal:loggedDates', { notebookId })).journalStart).toBe(MONDAY);

    workspace.restart();
    expect((await workspace.call('journal:loggedDates', { notebookId })).journalStart).toBe(MONDAY);
  });

  it('[J01] refuses something that is not a calendar day', async () => {
    const notebookId = await workspace.notebook('Do induction heads appear in VLAs?');
    const result = await workspace.attempt('journal:write', {
      notebookId,
      date: '20 July 2026',
      markdown: ENTRY,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_REQUEST');
  });

  it('[J03] links an entry to the notebook it advances', async () => {
    const notebookId = await workspace.notebook('Where the day was written');
    const advanced = await workspace.notebook('Do induction heads appear in VLAs?');
    const other = await workspace.notebook('Does the J-space latent decode to language?');
    await workspace.call('journal:write', { notebookId, date: MONDAY, markdown: ENTRY });

    await workspace.call('journal:advancesNotebook', {
      notebookId,
      date: MONDAY,
      advancesId: advanced,
    });

    workspace.restart();

    // The same table, the same reference query as everything else in the wiki.
    const { links } = await workspace.call('link:findReferences', {
      entityType: 'journal',
      entityId: journalEntityId(notebookId, MONDAY),
      direction: 'outgoing',
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.type).toBe('journal-entry-advances-question');
    expect(links[0]?.targetId).toBe(advanced);
    expect(links[0]?.broken).toBe(false);
    expect(links[0]?.otherTitle).toBe('Do induction heads appear in VLAs?');

    // And the notebook can say which days moved it forward, which is the direction the
    // reader actually asks in.
    const incoming = await workspace.call('link:findReferences', {
      entityType: 'question',
      entityId: advanced,
      direction: 'incoming',
    });
    expect(incoming.links.map((link) => link.sourceId)).toEqual([
      journalEntityId(notebookId, MONDAY),
    ]);
    const untouched = await workspace.call('link:findReferences', {
      entityType: 'question',
      entityId: other,
      direction: 'incoming',
    });
    expect(untouched.links).toEqual([]);
  });

  it('[J03] refuses a link from a day with no entry, or to a notebook that is not there', async () => {
    const notebookId = await workspace.notebook('Where the day was written');
    const advanced = await workspace.notebook('Do induction heads appear in VLAs?');

    const noEntry = await workspace.attempt('journal:advancesNotebook', {
      notebookId,
      date: THURSDAY,
      advancesId: advanced,
    });
    expect(noEntry.ok).toBe(false);
    if (!noEntry.ok) expect(noEntry.error.code).toBe('NOT_FOUND');

    await workspace.call('journal:write', { notebookId, date: THURSDAY, markdown: ENTRY });
    const noNotebook = await workspace.attempt('journal:advancesNotebook', {
      notebookId,
      date: THURSDAY,
      advancesId: 'qst_00000000000000000000000000',
    });
    expect(noNotebook.ok).toBe(false);
    if (!noNotebook.ok) expect(noNotebook.error.code).toBe('NOT_FOUND');

    const { links } = await workspace.call('link:findReferences', {
      entityType: 'journal',
      entityId: journalEntityId(notebookId, THURSDAY),
      direction: 'outgoing',
    });
    expect(links).toEqual([]);
  });
});
