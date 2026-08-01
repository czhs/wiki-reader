/**
 * The demo library, against a real database and real markdown on disk (criterion `B07`).
 *
 * The end-to-end spec proves the surfaces fill; this proves the parts of the promise that are
 * invisible from a panel. Three of them, and each is a way this could quietly go wrong:
 *
 * - **it is development only.** A packaged build must not be able to grow six papers nobody
 *   imported, so the refusal is asserted against a container built the way a packaged one is;
 * - **one action clears it, and only it.** The researcher's own rows have to come back exactly
 *   as they were, which is the assertion worth making twice — this is a convenience that can
 *   destroy a library if the predicate is wrong;
 * - **it is made the way real content is made.** The papers are ingested by the real corpus
 *   importer, so they carry slugs, wikilink edges and index entries. A demo built by inserting
 *   rows would look identical in a panel and be a demo of a library this app cannot produce.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_SOURCE } from '../../apps/desktop/src/main/demo.js';
import { IntegrationWorkspace } from './support/workspace.js';

class Workspace extends IntegrationWorkspace {
  constructor(development = true) {
    super('wr-demo-', () => ({ development }));
  }
}

let workspace: Workspace;

afterEach(() => {
  workspace.dispose();
});

describe('the demo library', () => {
  beforeEach(() => {
    workspace = new Workspace();
  });

  it('[B07] fills every surface, and says what it made', async () => {
    expect((await workspace.call('demo:status', {})).filled).toBe(false);

    const summary = await workspace.call('demo:fill', {});
    expect(summary.documents).toBeGreaterThanOrEqual(6);
    expect(summary.highlights).toBeGreaterThanOrEqual(3);
    expect(summary.notebooks).toBeGreaterThanOrEqual(3);
    expect(summary.journalDays).toBeGreaterThanOrEqual(3);
    expect(summary.notes).toBe(1);

    const { db } = workspace.services;

    // Papers, made by the real importer: each carries the slug ingestion mints and the file it
    // was read from, which is what makes it openable rather than a row that looks like one.
    const documents = db.documents.list({ source: DEMO_SOURCE, limit: 50 }).items;
    expect(documents.length).toBe(summary.documents);
    for (const document of documents) {
      expect(document.docType).toBe('markdown');
      expect(document.slug, `${document.title} has no slug`).not.toBeNull();
      expect(db.files.listByDocument(document.id).length).toBeGreaterThan(0);
    }

    // Edges the demo did not write: the wikilinks between the papers, parsed out of the
    // markdown by ingestion. That is the difference between a demo and a fixture.
    const derived = documents.flatMap((document) =>
      db.links
        .findReferences({ entityType: 'document', entityId: document.id })
        .filter((link) => link.type === 'document-references-document'),
    );
    expect(derived.length, 'the demo wiki has no links between its own pages').toBeGreaterThan(2);

    // Highlights, and edges from them — which is what makes the wiki draw a quote at all.
    const marked = documents.flatMap((document) => db.annotations.listByDocument(document.id));
    expect(marked.length).toBe(summary.highlights);
    const fromHighlights = marked.flatMap((annotation) =>
      db.links
        .findReferences({ entityType: 'annotation', entityId: annotation.id })
        .filter((link) => link.type !== 'annotation-belongs-to-document'),
    );
    expect(fromHighlights.length).toBeGreaterThan(2);

    // The notebook shelves: something to work on, something queued, and something set aside —
    // so the discarded shelf is not an empty box the first time anybody looks at it.
    const notebooks = db.questions.list({});
    expect(notebooks.some((question) => question.status === 'active')).toBe(true);
    expect(notebooks.some((question) => question.status === 'queued')).toBe(true);
    const discarded = notebooks.find((question) => question.status === 'discarded');
    expect(discarded?.discardedReason ?? '').not.toBe('');

    // A page with prose on it, claims with evidence on both sides, and a journal with days.
    const working = notebooks.find((question) => question.status === 'active');
    if (working === undefined) throw new Error('the demo opened no notebook to work in');
    expect((db.questions.readBody(working.id) ?? '').length).toBeGreaterThan(200);
    const claims = db.hypotheses.listForQuestion(working.id);
    expect(claims.length).toBeGreaterThanOrEqual(2);
    const evidence = db.links.findReferences({
      entityType: 'hypothesis',
      entityId: claims[0]?.id ?? '',
    });
    expect(evidence.some((link) => link.type.endsWith('supports-hypothesis'))).toBe(true);
    expect(evidence.some((link) => link.type.endsWith('opposes-hypothesis'))).toBe(true);
    expect(db.journal.count(working.id)).toBe(summary.journalDays);

    // And it is findable: a demo whose papers and marked sentences do not answer a search
    // would leave the one surface that is nothing but results empty.
    const hits = await workspace.call('search:query', { query: 'spacing' });
    expect(hits.results.length).toBeGreaterThan(0);

    const status = await workspace.call('demo:status', {});
    expect(status.filled).toBe(true);
    expect(status.documents).toBe(summary.documents);
  });

  it('[B07] one action clears it, and leaves everything else exactly as it was', async () => {
    // The researcher's own library, made before the demo and asserted after it has gone. This
    // is the test that matters: a wrong predicate here deletes somebody's work.
    const { db } = workspace.services;
    const mine = db.documents.create({
      title: 'A paper I actually imported',
      docType: 'pdf',
      source: 'zotero',
      authors: [],
    });
    const myNotebook = db.questions.create({ title: 'My own question', status: 'active' });
    const myNote = db.notes.create({
      title: 'My own note',
      contentJson: { type: 'doc', content: [] },
      contentText: 'mine',
    });

    await workspace.call('demo:fill', {});
    const cleared = await workspace.call('demo:clear', {});
    expect(cleared.documents).toBeGreaterThanOrEqual(6);
    expect(cleared.notebooks).toBeGreaterThanOrEqual(3);
    expect(cleared.notes).toBe(1);

    // Gone outright, not tombstoned: a hidden row comes back the moment anything lists
    // deleted material, and this was never the researcher's to keep.
    expect(db.documents.list({ source: DEMO_SOURCE, includeDeleted: true }).items).toEqual([]);
    const status = await workspace.call('demo:status', {});
    expect(status.filled).toBe(false);
    expect(status.documents).toBe(0);
    expect(status.notebooks).toBe(0);

    // …and mine is untouched, down to the note nothing else in this app can distinguish from
    // the demo's own.
    expect(db.documents.getById(mine.id)?.title).toBe('A paper I actually imported');
    expect(db.questions.get(myNotebook.id)?.title).toBe('My own question');
    expect(db.notes.get(myNote.id)?.title).toBe('My own note');
  });

  it('[B07] filling twice adds nothing the second time', async () => {
    const first = await workspace.call('demo:fill', {});
    const second = await workspace.call('demo:fill', {});
    // Idempotent by construction rather than by a guard — the importer skips unchanged bytes,
    // the marks and edges are looked up first, and the notebooks are only opened when the ones
    // remembered have gone. It matters because pressing it is how anyone finds out what it does.
    expect(second.documents).toBe(first.documents);
    expect(second.highlights).toBe(first.highlights);
    expect(second.notebooks).toBe(0);
    expect(second.notes).toBe(0);
    expect(workspace.services.db.questions.list({}).length).toBe(first.notebooks);
  });

  it('[B07] survives a restart as ordinary library content', async () => {
    await workspace.call('demo:fill', {});
    workspace.restart();
    // Nothing about the demo is held in memory: it is rows and files, which is the whole point
    // of making it through the real ingestion path.
    const status = await workspace.call('demo:status', {});
    expect(status.filled).toBe(true);
    expect(status.documents).toBeGreaterThanOrEqual(6);

    const cleared = await workspace.call('demo:clear', {});
    expect(cleared.documents).toBe(status.documents);
    expect(cleared.notebooks).toBeGreaterThanOrEqual(3);
  });
});

describe('a build that is not a development build', () => {
  beforeEach(() => {
    workspace = new Workspace(false);
  });

  it('[B07] has no demo content and refuses to make any', async () => {
    const status = await workspace.call('demo:status', {});
    expect(status.available).toBe(false);

    for (const channel of ['demo:fill', 'demo:clear'] as const) {
      const refused = await workspace.failure(channel, {});
      expect(refused.code).toBe('CONFLICT');
    }
    // The refusal is before anything is written, not a write that is undone afterwards.
    expect(workspace.services.db.documents.list({ source: DEMO_SOURCE }).items).toEqual([]);
    expect(workspace.services.db.questions.list({})).toEqual([]);
  });
});
