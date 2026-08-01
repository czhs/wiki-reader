/**
 * Field notebooks: the page behind a question (criteria N01, N03, N04, N05).
 *
 * Every request crosses the real router with its zod validation into a real SQLite file, and
 * each persistence assertion closes the services and reopens them against the same file — an
 * application restart, not a cache flush.
 *
 * Three things are asserted in the form that fails against the wrong implementation:
 *
 * - The body is stored as **source**. Fieldstation stored rendered HTML from a
 *   `contenteditable` and had to migrate away from it, so the assertion is byte equality of
 *   the markdown, not equality of what it renders to.
 * - The cover is a **file id**, and the page the renderer receives carries no filesystem
 *   path. A test that only read the cover back would pass on an implementation that handed
 *   the renderer an absolute path.
 * - Evidence is **resolved**, not echoed. Evidence-shaped text is not evidence — the same
 *   trap as `A04` — so each citation is asserted to come back with the title and the
 *   location of the thing it cites, which an implementation storing only ids cannot produce.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blankNotebook, notebookSections } from '@wr/document-model';
import { journalEntityId } from '@wr/shared-types';
import type {
  AnnotationWithAnchor,
  Document,
  Question,
} from '@wr/shared-types';
import {
  IntegrationWorkspace,
  SAMPLE_QUOTE,
  sampleMarkdownAnchor,
} from './support/workspace.js';

class Workspace extends IntegrationWorkspace {
  constructor() {
    super('wr-notebook-');
  }
}

let workspace: Workspace;

beforeEach(() => {
  workspace = new Workspace();
});

afterEach(() => {
  workspace.dispose();
});

async function ask(title: string): Promise<Question> {
  const { question } = await workspace.call('question:create', { title });
  return question;
}


function paper(title: string): Document {
  return workspace.services.db.documents.create({
    title,
    docType: 'markdown',
    source: 'corpus',
    authors: [],
  });
}

/** A highlight on a paper, created the way the reader creates one. */
async function highlightOn(document: Document): Promise<AnnotationWithAnchor> {
  const { annotation } = await workspace.call('annotation:create', {
    documentId: document.id,
    kind: 'highlight',
    color: 'default',
    selectedText: SAMPLE_QUOTE,
    comment: null,
    anchor: sampleMarkdownAnchor(),
  });
  return annotation;
}

/**
 * An image in the library, with real bytes on disk — the rows a file added to the library
 * produces, so the cover names something `rrfile://` can actually serve.
 */
function coverImage(): { fileId: string; path: string } {
  const path = join(workspace.dir, 'cover.png');
  // A 1×1 PNG. Real bytes, because the row records their size and hash.
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  writeFileSync(path, bytes);
  const document = workspace.services.db.documents.create({
    title: 'Induction head diagram',
    docType: 'other',
    source: 'local',
    authors: [],
  });
  const { file } = workspace.services.db.files.upsertByPath({
    documentId: document.id,
    path,
    mimeType: 'image/png',
    byteSize: bytes.byteLength,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    role: 'primary',
  });
  return { fileId: file.id, path };
}

// ---------------------------------------------------------------------------
// N01 — the page behind a question
// ---------------------------------------------------------------------------

describe('a question’s page', () => {
  it('[N01] keeps the markdown source, byte for byte, across a restart', async () => {
    const question = await ask('Do induction heads appear in VLAs?');
    const body = [
      '## The question',
      '',
      'Do induction heads appear in vision-language models — and if so, where?',
      '',
      '## Experiment log',
      '',
      '### 2026-07-27',
      '',
      'Ran the sweep. Config, verbatim:',
      '',
      '```yaml',
      'width:  4096',
      'seeds: [0, 1, 2]',
      '```',
      '',
      'Two trailing spaces end this line — they are a hard break.  ',
      'So this is the second line of the same paragraph.',
      '',
    ].join('\n');

    await workspace.call('question:writeNotebook', { questionId: question.id, body });
    workspace.restart();

    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    // Byte equality, not equality after rendering: an implementation that stored HTML, or
    // that normalised the fence or the hard break, fails here.
    expect(page.body).toBe(body);
    expect(notebookSections(page.body).map((section) => section.heading)).toEqual([
      'The question',
      'Experiment log',
    ]);
  });

  it('[N01] opens a page nobody has written on the blank template, without storing one', async () => {
    const question = await ask('Does SDFT preserve induction behaviour?');

    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    expect(page.body).toBe(blankNotebook());

    // The template is what a blank page *looks* like, not something written on the
    // researcher's behalf. Nothing is stored until they type.
    const row = workspace.services.db.sqlite
      .prepare('SELECT body FROM questions WHERE id = ?')
      .get(question.id) as { body: string };
    expect(row.body).toBe('');
  });

  it('[N01] names the question the page belongs to', async () => {
    const question = await ask('Do induction heads appear in VLAs?');

    const { page } = await workspace.call('question:notebook', { questionId: question.id });

    expect(page.question.id).toBe(question.id);
    expect(page.question.title).toBe('Do induction heads appear in VLAs?');
  });

  it('[N01] refuses a page for a question that does not exist', async () => {
    const result = await workspace.attempt('question:writeNotebook', {
      questionId: 'qst_00000000000000000000000000',
      body: '## The question',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });

  /**
   * The word retires in the failures too (`P01`).
   *
   * Milestone 5's rule is that "question" stops being a word the researcher has to know. The
   * screens were renamed; the refusals were not. Every one of these channels answers a missing
   * notebook with a message the renderer shows verbatim — on the notebook page's own error
   * state, and on the status line — and each of them said "question not found" about a thing
   * the app now calls a notebook. Asserted over the whole set rather than one channel, because
   * this was nine call sites in a file where the same fix had already been made three times.
   */
  it('[P01] says notebook, not question, in every refusal a missing notebook can produce', async () => {
    const missing = 'qst_00000000000000000000000000';
    const requests: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['question:get', { questionId: missing }],
      ['question:notebook', { questionId: missing }],
      ['question:writeNotebook', { questionId: missing, body: '## Anything' }],
      ['question:update', { questionId: missing, title: 'Anything' }],
      ['question:discard', { questionId: missing, reason: 'not worth it' }],
      ['question:reorder', { questionIds: [missing] }],
      ['question:attach', { questionId: missing, targetType: 'document', targetId: 'doc_00000000000000000000000000' }],
      ['hypothesis:create', { questionId: missing, statement: 'Anything' }],
      ['journal:get', { notebookId: missing, date: '2026-07-31' }],
      ['journal:write', { notebookId: missing, date: '2026-07-31', markdown: 'today' }],
      ['journal:loggedDates', { notebookId: missing }],
      ['journal:advancesNotebook', { notebookId: missing, date: '2026-07-31', advancesId: missing }],
    ];

    for (const [channel, request] of requests) {
      const result = await workspace.attempt(channel, request);
      expect(result.ok, `${channel} answered a missing notebook`).toBe(false);
      const message = result.ok ? '' : result.error.message;
      expect(message.toLowerCase(), `${channel} says "question"`).not.toContain('question');
    }
  });
});

// ---------------------------------------------------------------------------
// N03 — the front matter
// ---------------------------------------------------------------------------

describe('a page’s front matter', () => {
  it('[N03] carries description, importance, started, next action, tags and cover across a restart', async () => {
    const question = await ask('Do induction heads appear in VLAs?');
    const cover = coverImage();

    await workspace.call('question:update', {
      questionId: question.id,
      status: 'active',
      description: 'Whether the copying circuit survives a vision encoder in front of it.',
      importance: 4,
      nextAction: 'Run the attention-pattern sweep on PaliGemma',
      tags: ['interpretability', 'vlm'],
      coverFileId: cover.fileId,
    });

    workspace.restart();

    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    expect(page.question.description).toBe(
      'Whether the copying circuit survives a vision encoder in front of it.',
    );
    expect(page.question.importance).toBe(4);
    expect(page.question.nextAction).toBe('Run the attention-pattern sweep on PaliGemma');
    expect(page.question.tags).toEqual(['interpretability', 'vlm']);
    expect(page.question.coverFileId).toBe(cover.fileId);
    // `started` is when work began, which the queue already records the moment a question
    // becomes active.
    expect(page.question.startedAt).not.toBeNull();
  });

  it('[N03] gives the renderer a cover it can load without ever seeing a path', async () => {
    const question = await ask('Do induction heads appear in VLAs?');
    const cover = coverImage();

    await workspace.call('question:update', { questionId: question.id, coverFileId: cover.fileId });
    const { page } = await workspace.call('question:notebook', { questionId: question.id });

    // The file id resolves to real bytes on disk in the main process...
    const file = workspace.services.db.files.getById(cover.fileId);
    expect(file?.path).toBe(cover.path);
    // ...and none of that path is anywhere in what crosses to the renderer.
    expect(JSON.stringify(page)).not.toContain(workspace.dir);
    expect(JSON.stringify(page)).not.toContain('cover.png');
  });

  it('[N03] refuses a cover that is not a file in the library', async () => {
    const question = await ask('Do induction heads appear in VLAs?');

    const result = await workspace.attempt('question:update', {
      questionId: question.id,
      coverFileId: 'dfl_00000000000000000000000000',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    expect(page.question.coverFileId).toBeNull();
  });

  it('[N03] replaces the tag set rather than accumulating it', async () => {
    const question = await ask('Do induction heads appear in VLAs?');

    await workspace.call('question:update', { questionId: question.id, tags: ['vlm', 'sweep'] });
    await workspace.call('question:update', { questionId: question.id, tags: ['vlm'] });
    workspace.restart();

    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    expect(page.question.tags).toEqual(['vlm']);
    // And a tag is a tag: the same rows the library already tags documents with.
    expect(workspace.services.db.tags.list().map((tag) => tag.name)).toEqual(
      expect.arrayContaining(['sweep', 'vlm']),
    );
  });
});

// ---------------------------------------------------------------------------
// N04 — hypotheses as entities
// ---------------------------------------------------------------------------

describe('a hypothesis', () => {
  it('[N04] is an entity on its question, with its own id and status', async () => {
    const question = await ask('Do induction heads appear in VLAs?');

    const { hypothesis: first } = await workspace.call('hypothesis:create', {
      questionId: question.id,
      statement: 'The copying behaviour is carried by attention-only layers.',
    });
    const { hypothesis: second } = await workspace.call('hypothesis:create', {
      questionId: question.id,
      statement: 'The vision encoder destroys the previous-token dependency.',
    });
    expect(first.status).toBe('open');
    expect(first.id).not.toBe(second.id);

    await workspace.call('hypothesis:update', { hypothesisId: first.id, status: 'supported' });
    workspace.restart();

    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    expect(page.hypotheses.map((h) => ({ id: h.id, status: h.status }))).toEqual([
      { id: first.id, status: 'supported' },
      { id: second.id, status: 'open' },
    ]);
    expect(page.hypotheses[0]?.statement).toBe(
      'The copying behaviour is carried by attention-only layers.',
    );
  });

  it('[N04] belongs to one question and appears on no other page', async () => {
    const mine = await ask('Do induction heads appear in VLAs?');
    const other = await ask('Does SDFT preserve induction behaviour?');
    await workspace.call('hypothesis:create', {
      questionId: mine.id,
      statement: 'Attention-only layers carry it.',
    });

    const { page } = await workspace.call('question:notebook', { questionId: other.id });
    expect(page.hypotheses).toEqual([]);
  });

  it('[N04] refuses a status outside the four, at the schema and not only above it', async () => {
    const question = await ask('Do induction heads appear in VLAs?');
    const { hypothesis } = await workspace.call('hypothesis:create', {
      questionId: question.id,
      statement: 'Attention-only layers carry it.',
    });

    const rejected = await workspace.attempt('hypothesis:update', {
      hypothesisId: hypothesis.id,
      status: 'probably',
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('INVALID_REQUEST');

    expect(() =>
      workspace.services.db.sqlite
        .prepare('UPDATE hypotheses SET status = ? WHERE id = ?')
        .run('probably', hypothesis.id),
    ).toThrow();
  });

  it('[N04] refuses a hypothesis on a question that does not exist', async () => {
    const result = await workspace.attempt('hypothesis:create', {
      questionId: 'qst_00000000000000000000000000',
      statement: 'A claim about nothing.',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// N06 — a thing sent to a notebook lands as a block in its page (P06)
// ---------------------------------------------------------------------------

/**
 * The desk retired and its cards became blocks (`P06`, superseding `N06`).
 *
 * A card was never a thing in its own right: it *was* the `question-references-…` edge, drawn
 * on a second surface beside the page. So retiring the board loses no relationship — every
 * assertion about the edge below is the same one the board's suite made — and what is new is
 * that the researcher can now see what they collected in the document they are writing, and
 * write around it.
 *
 * The property worth testing twice is idempotence. Blocks are appended by the main process
 * from three directions (a send, a drop, the one-time migration off the desk), and a page that
 * grows a second copy of a paper every time something re-runs is worse than one that never
 * showed it.
 */
describe('a thing sent to a notebook', () => {
  const body = (questionId: string): string =>
    workspace.services.db.questions.readBody(questionId) ?? '';

  it('[N06] lands a paper as a block that names it and links to it', async () => {
    const question = await ask('Which papers show the copying circuit?');
    const document = paper('Olsson et al. — In-context learning and induction heads');

    await workspace.call('question:attach', {
      questionId: question.id,
      targetType: 'document',
      targetId: document.id,
    });

    // The edge, unchanged: it is what the graph, the ledger and the references panel read.
    const references = workspace.services.db.links.findReferences({
      entityType: 'question',
      entityId: question.id,
      direction: 'outgoing',
    });
    expect(references.map((link) => link.type)).toEqual(['question-references-document']);

    // …and the block, which is the half the researcher can see and edit.
    const written = body(question.id);
    expect(written).toContain('Olsson et al. — In-context learning and induction heads');
    expect(written).toContain(`(document://${document.id})`);
    // It is on the page the channel answers with, not only in the row: `question:notebook` is
    // what the panel reads, and there is no `cards` array beside it any more.
    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    expect(page.body).toContain(`(document://${document.id})`);
    expect(page).not.toHaveProperty('cards');
  });

  it('[N06] lands a highlight as the sentence it marks, linked back to it', async () => {
    const question = await ask('Which papers show the copying circuit?');
    const document = paper('Olsson et al. — In-context learning and induction heads');
    const annotation = await highlightOn(document);

    await workspace.call('question:attach', {
      questionId: question.id,
      targetType: 'annotation',
      targetId: annotation.id,
    });

    const written = body(question.id);
    // A blockquote and an attribution, which is what an excerpt is everywhere else in the app
    // (`S03`) — one spelling of "a quote in a notebook", not two.
    expect(written).toContain(`> ${annotation.selectedText}`);
    expect(written).toContain(`(annotation://${annotation.id})`);
  });

  it('[N06] does not write the same thing into the page twice', async () => {
    const question = await ask('Which papers show the copying circuit?');
    const document = paper('Olsson et al. — In-context learning and induction heads');
    const attach = async (): Promise<void> => {
      await workspace.call('question:attach', {
        questionId: question.id,
        targetType: 'document',
        targetId: document.id,
      });
    };

    await attach();
    await attach();

    expect(body(question.id).split('document://').length - 1).toBe(1);
  });

  it('[N06] leaves the block alone when the caller is writing it itself', async () => {
    // The page's own excerpt picker inserts the quote where the caret is, and asks only for
    // the edge. Without `landsAsBlock: false` the researcher would get their quote twice.
    const question = await ask('Which papers show the copying circuit?');
    const document = paper('Olsson et al. — In-context learning and induction heads');
    const annotation = await highlightOn(document);

    await workspace.call('question:attach', {
      questionId: question.id,
      targetType: 'annotation',
      targetId: annotation.id,
      landsAsBlock: false,
    });

    expect(body(question.id)).toBe('');
    expect(
      workspace.services.db.links.findReferences({
        entityType: 'question',
        entityId: question.id,
        direction: 'outgoing',
      }),
    ).toHaveLength(1);
  });

  it('[N06] survives a restart, because the block is in the document', async () => {
    const question = await ask('Which papers show the copying circuit?');
    const document = paper('Olsson et al. — In-context learning and induction heads');
    await workspace.call('question:attach', {
      questionId: question.id,
      targetType: 'document',
      targetId: document.id,
    });

    workspace.restart();

    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    expect(page.body).toContain(`(document://${document.id})`);
  });

  it('[N06] keeps the block when the paper it names is removed from the library', async () => {
    // A card whose paper had gone was drawn with a hole in it. A block is prose the researcher
    // has since written around, so it stays exactly as it is — the link stops resolving, which
    // is a fact about the library rather than a reason to edit somebody's page.
    const question = await ask('Which papers show the copying circuit?');
    const document = paper('A paper that will be removed');
    await workspace.call('question:attach', {
      questionId: question.id,
      targetType: 'document',
      targetId: document.id,
    });

    workspace.services.db.documents.purge(document.id);

    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    expect(page.body).toContain('A paper that will be removed');
  });
});

// ---------------------------------------------------------------------------
// N05 — evidence for and against a claim
// ---------------------------------------------------------------------------

describe('evidence on a hypothesis', () => {
  it('[N05] takes a side, and every citation resolves to what it cites', async () => {
    const question = await ask('Do induction heads appear in VLAs?');
    const { hypothesis } = await workspace.call('hypothesis:create', {
      questionId: question.id,
      statement: 'The copying behaviour is carried by attention-only layers.',
    });
    const forIt = paper('Olsson et al. — In-context learning and induction heads');
    const supporting = await highlightOn(forIt);
    const against = paper('Wang et al. — The vision encoder breaks the dependency');

    await workspace.call('hypothesis:attachEvidence', {
      hypothesisId: hypothesis.id,
      stance: 'supports',
      sourceType: 'annotation',
      sourceId: supporting.id,
    });
    await workspace.call('hypothesis:attachEvidence', {
      hypothesisId: hypothesis.id,
      stance: 'opposes',
      sourceType: 'document',
      sourceId: against.id,
      label: 'their fig. 3 contradicts it directly',
    });

    workspace.restart();

    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    const claim = page.hypotheses[0];
    expect(claim?.supporting).toHaveLength(1);
    expect(claim?.opposing).toHaveLength(1);

    // Resolved, not echoed: the highlight comes back as its own text with the location that
    // opens it, and the paper as its title. An implementation that stored ids and handed
    // them back cannot produce either.
    const cited = claim?.supporting[0];
    expect(cited?.otherTitle).toContain('Induction heads copy the token');
    expect(cited?.otherLocation).not.toBeNull();
    expect(cited?.broken).toBe(false);
    expect(claim?.opposing[0]?.otherTitle).toBe(
      'Wang et al. — The vision encoder breaks the dependency',
    );
    expect(claim?.opposing[0]?.label).toBe('their fig. 3 contradicts it directly');
    expect(claim?.opposing[0]?.broken).toBe(false);
  });

  it('[N05] is an ordinary typed edge, reachable from the paper as well', async () => {
    const question = await ask('Do induction heads appear in VLAs?');
    const { hypothesis } = await workspace.call('hypothesis:create', {
      questionId: question.id,
      statement: 'Attention-only layers carry it.',
    });
    const against = paper('Wang et al. — The vision encoder breaks the dependency');

    await workspace.call('hypothesis:attachEvidence', {
      hypothesisId: hypothesis.id,
      stance: 'opposes',
      sourceType: 'document',
      sourceId: against.id,
    });

    // Same table, same shape, same query as every other relationship in the app.
    const { links } = await workspace.call('link:findReferences', {
      entityType: 'document',
      entityId: against.id,
      direction: 'outgoing',
    });
    expect(links.map((link) => ({ type: link.type, targetId: link.targetId }))).toEqual([
      { type: 'document-opposes-hypothesis', targetId: hypothesis.id },
    ]);
    // And the hypothesis resolves as an endpoint, so the edge is not broken from that side.
    expect(links[0]?.otherTitle).toBe('Attention-only layers carry it.');
    expect(links[0]?.broken).toBe(false);
  });

  it('[N05] refuses evidence that is not in the wiki', async () => {
    const question = await ask('Do induction heads appear in VLAs?');
    const { hypothesis } = await workspace.call('hypothesis:create', {
      questionId: question.id,
      statement: 'Attention-only layers carry it.',
    });

    const result = await workspace.attempt('hypothesis:attachEvidence', {
      hypothesisId: hypothesis.id,
      stance: 'supports',
      sourceType: 'document',
      sourceId: 'doc_00000000000000000000000000',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    expect(page.hypotheses[0]?.supporting).toEqual([]);
  });

  it('[N05] refuses a stance that is neither for nor against', async () => {
    const question = await ask('Do induction heads appear in VLAs?');
    const { hypothesis } = await workspace.call('hypothesis:create', {
      questionId: question.id,
      statement: 'Attention-only layers carry it.',
    });
    const document = paper('A paper with an opinion');

    const result = await workspace.attempt('hypothesis:attachEvidence', {
      hypothesisId: hypothesis.id,
      stance: 'mentions',
      sourceType: 'document',
      sourceId: document.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_REQUEST');
  });
});

/**
 * The desk's data, on its way into the pages it belonged to (`P06`).
 *
 * A database written before this milestone has `question-references-…` edges and a body that
 * says nothing about them, because the only place they were ever shown was a board. The pass
 * in `createServices` gives each of them a block. What is tested here is not that it runs but
 * that it is safe to run *again*: it fires at every start, and a page that grows a second copy
 * of a paper each time is worse than one that never showed it.
 */
describe('retiring the desk into the page', () => {
  /** A notebook as it looked before `P06`: edges, and a body that does not mention them. */
  async function withCardsAndNoBlocks(): Promise<{
    questionId: string;
    documentId: string;
    annotationId: string;
  }> {
    const { db } = workspace.services;
    const question = await ask('Which papers show the copying circuit?');
    const document = paper('Olsson et al. — In-context learning and induction heads');
    const annotation = await highlightOn(document);
    for (const [type, targetType, targetId] of [
      ['question-references-document', 'document', document.id],
      ['question-references-annotation', 'annotation', annotation.id],
    ] as const) {
      db.links.create({
        type,
        sourceType: 'question',
        sourceId: question.id,
        targetType,
        targetId,
        origin: 'manual',
      });
    }
    // The body is untouched by those writes, which is exactly the old state.
    expect(db.questions.readBody(question.id) ?? '').toBe('');
    // And the pass has already run once for this workspace, so its mark has to go for the
    // restart below to stand in for a database that has never seen it.
    db.settings.delete('notebook.deskRetired');
    return { questionId: question.id, documentId: document.id, annotationId: annotation.id };
  }

  it('[P06] lands every card as a block the first time the app opens the database', async () => {
    const seeded = await withCardsAndNoBlocks();

    workspace.restart();

    const { page } = await workspace.call('question:notebook', { questionId: seeded.questionId });
    expect(page.body).toContain(`(document://${seeded.documentId})`);
    expect(page.body).toContain(`(annotation://${seeded.annotationId})`);
    // The edges are untouched: the migration is a second view of them, not a move.
    expect(
      workspace.services.db.links.findReferences({
        entityType: 'question',
        entityId: seeded.questionId,
        direction: 'outgoing',
      }),
    ).toHaveLength(2);
  });

  it('[P06] does not write them again on the next start, or the one after', async () => {
    const seeded = await withCardsAndNoBlocks();

    workspace.restart();
    const once = workspace.services.db.questions.readBody(seeded.questionId) ?? '';
    workspace.restart();
    // …and again with the mark cleared, which is the case a marker alone would not survive.
    workspace.services.db.settings.delete('notebook.deskRetired');
    workspace.restart();

    expect(workspace.services.db.questions.readBody(seeded.questionId) ?? '').toBe(once);
    expect(once.split('document://').length - 1).toBe(1);
  });

  it('[P06] leaves prose already on the page exactly where it was', async () => {
    const seeded = await withCardsAndNoBlocks();
    workspace.services.db.questions.writeBody(seeded.questionId, '## Method\n\nTwo schedules.\n');

    workspace.restart();

    const body = workspace.services.db.questions.readBody(seeded.questionId) ?? '';
    expect(body.startsWith('## Method\n\nTwo schedules.')).toBe(true);
    expect(body).toContain(`(document://${seeded.documentId})`);
  });
});

// ---------------------------------------------------------------------------
// I01 — deleting a notebook, which is the one irreversible act in the milestone
// ---------------------------------------------------------------------------

/**
 * What `questions.delete` takes, asked about the rows it was supposed to take.
 *
 * The method is hand-written polymorphic SQL over a table with no foreign keys, run in one
 * transaction alongside a cascade, and until this suite it had no unit or integration cover at
 * all — its only exercise was one E2E path whose after-state assertions could not fail for two
 * of the four things they claimed. Both were the same mistake: a predicate that resolves
 * *through* something the delete has already removed. `... IN (SELECT id FROM hypotheses WHERE
 * question_id = @id)` is empty once the cascade has run, so an orphaned
 * `annotation-supports-hypothesis` edge counts zero whether or not it went. (The other was a
 * desk position counted through a join on `links`, which counts zero as soon as the link is
 * gone whatever became of the row; the desk retired with `P06` and took that table with it.)
 *
 * So every row here is captured by **id** before the delete and asked about by that id
 * afterwards. That is also the only shape in which the repository's own warning — "two
 * spellings of 'what belongs to this notebook' is how a count comes to disagree with what
 * actually went" — can be checked rather than repeated.
 */
describe('deleting a notebook', () => {
  interface Worked {
    readonly notebookId: string;
    readonly documentId: string;
    readonly annotationId: string;
    readonly hypothesisId: string;
    readonly referenceLinkId: string;
    /** Every edge the seed wrote that belongs to the notebook, in the order written. */
    readonly ownedLinkIds: readonly string[];
    /** An edge between two library rows, which must survive. */
    readonly libraryLinkId: string;
  }

  /** A notebook with a day, a claim, a paper it refers to, and a citation. */
  async function workedNotebook(title: string): Promise<Worked> {
    const { db } = workspace.services;
    const question = await ask(title);
    const document = paper('Spacing effects in deep networks');
    const other = paper('Forgetting curves, revisited');
    const annotation = await highlightOn(document);

    await workspace.call('journal:write', {
      notebookId: question.id,
      date: '2026-07-20',
      markdown: 'Ran the sweep. Nothing separates the two schedules yet.',
    });

    const card = db.links.create({
      type: 'question-references-document',
      sourceType: 'question',
      sourceId: question.id,
      targetType: 'document',
      targetId: document.id,
      origin: 'manual',
    });

    const hypothesis = db.hypotheses.create({
      questionId: question.id,
      statement: 'Spacing wins because retrieval is harder.',
    });
    // Evidence for the claim. Its endpoints are an annotation and a hypothesis, so nothing in
    // the schema removes it: it is the edge the repository's hypothesis branch exists for and
    // the one the E2E count could not see.
    const evidence = db.links.create({
      type: 'annotation-supports-hypothesis',
      sourceType: 'annotation',
      sourceId: annotation.id,
      targetType: 'hypothesis',
      targetId: hypothesis.id,
      origin: 'manual',
    });
    // A day as a *source*, and a day as a *target*. The repository has both branches and the
    // spec that was supposed to cover this had only the first.
    const dayAdvances = db.links.create({
      type: 'journal-entry-advances-question',
      sourceType: 'journal',
      sourceId: journalEntityId(question.id, '2026-07-20'),
      targetType: 'question',
      targetId: question.id,
      origin: 'manual',
    });
    const paperAboutTheDay = db.links.create({
      type: 'related-to',
      sourceType: 'document',
      sourceId: other.id,
      targetType: 'journal',
      targetId: journalEntityId(question.id, '2026-07-20'),
      origin: 'manual',
    });
    // And a link that is purely the library's, which deletion must not touch.
    const libraryLink = db.links.create({
      type: 'related-to',
      sourceType: 'document',
      sourceId: document.id,
      targetType: 'document',
      targetId: other.id,
      origin: 'manual',
    });

    await workspace.call('question:discard', { questionId: question.id, reason: 'Answered.' });

    return {
      notebookId: question.id,
      documentId: document.id,
      annotationId: annotation.id,
      hypothesisId: hypothesis.id,
      referenceLinkId: card.id,
      ownedLinkIds: [card.id, evidence.id, dayAdvances.id, paperAboutTheDay.id],
      libraryLinkId: libraryLink.id,
    };
  }

  const rows = (sql: string, params: Record<string, unknown>): number =>
    (workspace.services.db.sqlite.prepare(sql).get(params) as { n: number } | undefined)?.n ?? 0;

  const linksById = (ids: readonly string[]): number =>
    (
      workspace.services.db.sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM links WHERE id IN (${ids.map(() => '?').join(', ')})`,
        )
        .get(...ids) as { n: number } | undefined
    )?.n ?? 0;

  it('[I01] puts a deleted notebook in the bin with everything it had, and brings it back', async () => {
    // The half `U11` added: deleting is now reversible, so nothing above may have gone yet.
    const worked = await workedNotebook('Does spacing beat massing in a 12-layer model?');
    const { question } = await workspace.call('question:delete', { questionId: worked.notebookId });
    expect(question.trashedAt).not.toBeNull();
    // Still discarded, still carrying why — the bin is a second step after that one, not an
    // alternative to it, which is what keeps `question:delete`'s precondition meaningful.
    expect(question.status).toBe('discarded');
    expect(question.discardedReason).toBe('Answered.');

    expect(rows('SELECT COUNT(*) AS n FROM questions WHERE id = @id', { id: worked.notebookId })).toBe(1);
    expect(linksById(worked.ownedLinkIds)).toBe(worked.ownedLinkIds.length);
    expect(
      rows('SELECT COUNT(*) AS n FROM journal_entries WHERE notebook_id = @id', {
        id: worked.notebookId,
      }),
    ).toBe(1);

    const back = await workspace.call('question:restoreFromTrash', {
      questionId: worked.notebookId,
    });
    expect(back.question.trashedAt).toBeNull();
    expect(back.question.status).toBe('discarded');
    expect(linksById(worked.ownedLinkIds)).toBe(worked.ownedLinkIds.length);
  });

  it('[I01] removes every edge the notebook owned, named by the ids it wrote', async () => {
    const worked = await workedNotebook('Does spacing beat massing in a 12-layer model?');
    expect(linksById(worked.ownedLinkIds)).toBe(worked.ownedLinkIds.length);

    await workspace.call('question:delete', { questionId: worked.notebookId });
    const { removed } = await workspace.call('question:emptyTrash', {});
    expect(removed).toEqual({
      notebooks: 1,
      journalDays: 1,
      hypotheses: 1,
      references: 1,
      links: 4,
    });

    // The four edges are gone, by id — including the hypothesis one, which is orphaned by the
    // cascade rather than reachable from it, and the day-as-target one the E2E predicate
    // omitted entirely.
    expect(linksById(worked.ownedLinkIds), 'an owned edge outlived its notebook').toBe(0);
    // And the cascades: the row, its day, its claim.
    expect(rows('SELECT COUNT(*) AS n FROM questions WHERE id = @id', { id: worked.notebookId })).toBe(0);
    expect(
      rows('SELECT COUNT(*) AS n FROM journal_entries WHERE notebook_id = @id', {
        id: worked.notebookId,
      }),
    ).toBe(0);
    expect(
      rows('SELECT COUNT(*) AS n FROM hypotheses WHERE id = @id', { id: worked.hypothesisId }),
    ).toBe(0);
  });

  it('[I01] leaves the reading it was done on exactly where it was', async () => {
    const worked = await workedNotebook('Does spacing beat massing in a 12-layer model?');
    await workspace.call('question:delete', { questionId: worked.notebookId });
    await workspace.call('question:emptyTrash', {});

    // The papers, the highlight, and the edge between two library rows: none of them was ever
    // the notebook's, and the polymorphic predicate must not have reached them.
    expect(
      rows('SELECT COUNT(*) AS n FROM documents WHERE id = @id AND deleted_at IS NULL', {
        id: worked.documentId,
      }),
    ).toBe(1);
    expect(
      rows('SELECT COUNT(*) AS n FROM annotations WHERE id = @id AND deleted_at IS NULL', {
        id: worked.annotationId,
      }),
    ).toBe(1);
    expect(linksById([worked.libraryLinkId]), 'deleting a notebook took a library edge').toBe(1);
    // The containment edge every highlight is born with is a library row too.
    expect(
      rows(
        `SELECT COUNT(*) AS n FROM links
          WHERE type = 'annotation-belongs-to-document' AND source_id = @id`,
        { id: worked.annotationId },
      ),
    ).toBe(1);
  });

  it('[I01] leaves a second notebook’s edges alone', async () => {
    const worked = await workedNotebook('Does spacing beat massing in a 12-layer model?');
    const neighbour = await workedNotebook('Does attention sparsity predict transfer?');

    // Only the one in the bin goes, which is the whole reason emptying takes no argument: the
    // bin is what it contains, and a notebook that was never deleted is not in it.
    await workspace.call('question:delete', { questionId: worked.notebookId });
    await workspace.call('question:emptyTrash', {});

    expect(linksById(neighbour.ownedLinkIds)).toBe(neighbour.ownedLinkIds.length);
    expect(
      rows('SELECT COUNT(*) AS n FROM journal_entries WHERE notebook_id = @id', {
        id: neighbour.notebookId,
      }),
    ).toBe(1);
  });

  it('[I01] refuses a notebook that has not been discarded, and takes nothing', async () => {
    const question = await ask('Still open, and still the thing to do');
    const document = paper('Spacing effects in deep networks');
    const card = workspace.services.db.links.create({
      type: 'question-references-document',
      sourceType: 'question',
      sourceId: question.id,
      targetType: 'document',
      targetId: document.id,
      origin: 'manual',
    });

    const result = await workspace.attempt('question:delete', { questionId: question.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_REQUEST');

    expect(rows('SELECT COUNT(*) AS n FROM questions WHERE id = @id', { id: question.id })).toBe(1);
    expect(linksById([card.id])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// E02 — the announcement, which is the half a mounted page depends on
// ---------------------------------------------------------------------------

/**
 * Who is told when an edge with an end on a notebook is written.
 *
 * The criterion's own layout is a reader beside the notebook, so the researcher makes the edge
 * on one panel and reads the result on another. `library:changed` is the wrong announcement for
 * that: the notebook page does not draw the library, it draws *this* notebook, and it listens
 * only to `notebook:changed`. Both routes to the same edge — the researcher's `link:create` and
 * the librarian's `hypothesis:attachEvidence` — have to say so, and the second used to say
 * nothing at all.
 */
describe('an edge with an end on a notebook', () => {
  const notebookEvents = (): { questionId: string; reason: string }[] =>
    workspace.publishedOn('notebook:changed') as { questionId: string; reason: string }[];

  it('[E02] tells the notebook when the researcher links evidence to one of its claims', async () => {
    const question = await ask('Do induction heads appear in VLAs?');
    const { hypothesis } = await workspace.call('hypothesis:create', {
      questionId: question.id,
      statement: 'Attention-only layers carry it.',
    });
    const document = paper('A paper with an opinion');
    const annotation = await highlightOn(document);
    const before = notebookEvents().length;

    await workspace.call('link:create', {
      type: 'annotation-supports-hypothesis',
      sourceType: 'annotation',
      sourceId: annotation.id,
      targetType: 'hypothesis',
      targetId: hypothesis.id,
      origin: 'manual',
    });

    expect(notebookEvents().slice(before)).toEqual([
      { questionId: question.id, reason: 'link', added: 0 },
    ]);
  });

  it('[E02] tells it when the librarian attaches the same evidence', async () => {
    const question = await ask('Do induction heads appear in VLAs?');
    const { hypothesis } = await workspace.call('hypothesis:create', {
      questionId: question.id,
      statement: 'Attention-only layers carry it.',
    });
    const document = paper('A paper with an opinion');
    const before = notebookEvents().length;

    await workspace.call('hypothesis:attachEvidence', {
      hypothesisId: hypothesis.id,
      stance: 'supports',
      sourceType: 'document',
      sourceId: document.id,
    });

    expect(notebookEvents().slice(before)).toEqual([
      { questionId: question.id, reason: 'link', added: 0 },
    ]);
  });

  it('[E02] tells it when a card or a day is an end of the edge, and nobody otherwise', async () => {
    const question = await ask('Do induction heads appear in VLAs?');
    const other = await ask('Does spacing beat massing?');
    const document = paper('A paper with an opinion');
    const second = paper('Another paper entirely');
    await workspace.call('journal:write', {
      notebookId: question.id,
      date: '2026-07-20',
      markdown: 'Ran the sweep.',
    });

    const before = notebookEvents().length;
    await workspace.call('link:create', {
      type: 'question-references-document',
      sourceType: 'question',
      sourceId: question.id,
      targetType: 'document',
      targetId: document.id,
      origin: 'manual',
    });
    await workspace.call('link:create', {
      type: 'journal-entry-advances-question',
      sourceType: 'journal',
      sourceId: journalEntityId(question.id, '2026-07-20'),
      targetType: 'question',
      targetId: question.id,
      origin: 'manual',
    });
    // Two library rows: no notebook is any the wiser, and neither is the other notebook.
    await workspace.call('link:create', {
      type: 'related-to',
      sourceType: 'document',
      sourceId: document.id,
      targetType: 'document',
      targetId: second.id,
      origin: 'manual',
    });

    expect(notebookEvents().slice(before)).toEqual([
      { questionId: question.id, reason: 'link', added: 0 },
      { questionId: question.id, reason: 'link', added: 0 },
    ]);
    expect(notebookEvents().every((event) => event.questionId !== other.id)).toBe(true);
  });

  it('[E02] says so again when the edge is taken away', async () => {
    const question = await ask('Do induction heads appear in VLAs?');
    const { hypothesis } = await workspace.call('hypothesis:create', {
      questionId: question.id,
      statement: 'Attention-only layers carry it.',
    });
    const document = paper('A paper with an opinion');
    const { link } = await workspace.call('link:create', {
      type: 'document-supports-hypothesis',
      sourceType: 'document',
      sourceId: document.id,
      targetType: 'hypothesis',
      targetId: hypothesis.id,
      origin: 'manual',
    });

    const before = notebookEvents().length;
    await workspace.call('link:delete', { linkId: link.id });
    expect(notebookEvents().slice(before)).toEqual([
      { questionId: question.id, reason: 'link', added: 0 },
    ]);
  });
});
