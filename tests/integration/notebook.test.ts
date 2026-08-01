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
      ['question:placeCard', { questionId: missing, linkId: 'lnk_00000000000000000000000000', x: 1, y: 1 }],
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
// N06 — the desk board
// ---------------------------------------------------------------------------

describe('a question’s desk board', () => {
  it('[N06] holds a card for every attachment, and stores no position until one is dragged', async () => {
    const question = await ask('Which papers show the copying circuit?');
    const paper1 = paper('Olsson et al. — In-context learning and induction heads');

    await workspace.call('question:attach', {
      questionId: question.id,
      targetType: 'document',
      targetId: paper1.id,
    });

    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0]?.entityId).toBe(paper1.id);
    expect(page.cards[0]?.title).toBe('Olsson et al. — In-context learning and induction heads');
    // The rule the board exists to keep: an arrangement nobody chose is not stored, so the
    // default can change later without moving cards somebody thinks they placed.
    expect(page.cards[0]?.position).toBeNull();
    const stored = workspace.services.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM card_positions')
      .get() as { n: number };
    expect(stored.n).toBe(0);
  });

  it('[N06] keeps a placed card’s coordinates across a restart', async () => {
    const question = await ask('Which papers show the copying circuit?');
    const placed = paper('Olsson et al. — In-context learning and induction heads');
    const untouched = paper('Wang et al. — The vision encoder breaks the dependency');
    const attach = async (documentId: string): Promise<string> => {
      const { link } = await workspace.call('question:attach', {
        questionId: question.id,
        targetType: 'document',
        targetId: documentId,
      });
      return link.id;
    };
    const movedLinkId = await attach(placed.id);
    await attach(untouched.id);

    await workspace.call('question:placeCard', {
      questionId: question.id,
      linkId: movedLinkId,
      x: 240.5,
      y: 96,
    });

    workspace.restart();

    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    const byEntity = new Map(page.cards.map((card) => [card.entityId, card]));
    expect(byEntity.get(placed.id)?.position).toEqual({ x: 240.5, y: 96 });
    // And the one nobody moved is still unplaced — "at the default" and "put here" are
    // different facts, and only the second one is the researcher's.
    expect(byEntity.get(untouched.id)?.position).toBeNull();
  });

  it('[N06] refuses a position for a card that is not on this question’s board', async () => {
    const mine = await ask('Which papers show the copying circuit?');
    const other = await ask('Does SDFT preserve induction behaviour?');
    const document = paper('Olsson et al. — In-context learning and induction heads');
    const { link } = await workspace.call('question:attach', {
      questionId: other.id,
      targetType: 'document',
      targetId: document.id,
    });

    const result = await workspace.attempt('question:placeCard', {
      questionId: mine.id,
      linkId: link.id,
      x: 10,
      y: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    const { page } = await workspace.call('question:notebook', { questionId: other.id });
    expect(page.cards[0]?.position).toBeNull();
  });

  it('[N06] takes the card off the board by deleting the edge, and the position goes with it', async () => {
    const question = await ask('Which papers show the copying circuit?');
    const document = paper('Olsson et al. — In-context learning and induction heads');
    const { link } = await workspace.call('question:attach', {
      questionId: question.id,
      targetType: 'document',
      targetId: document.id,
    });
    await workspace.call('question:placeCard', {
      questionId: question.id,
      linkId: link.id,
      x: 32,
      y: 48,
    });

    await workspace.call('link:delete', { linkId: link.id });

    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    expect(page.cards).toEqual([]);
    // A card is the edge, so there is one deletion and not two — and no orphan position
    // waiting to reappear under a later card.
    const left = workspace.services.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM card_positions')
      .get() as { n: number };
    expect(left.n).toBe(0);
  });

  it('[N06] shows a card whose paper has gone as broken rather than dropping it', async () => {
    const question = await ask('Which papers show the copying circuit?');
    const document = paper('A paper that will be removed');
    await workspace.call('question:attach', {
      questionId: question.id,
      targetType: 'document',
      targetId: document.id,
    });

    workspace.services.db.documents.purge(document.id);

    const { page } = await workspace.call('question:notebook', { questionId: question.id });
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0]?.broken).toBe(true);
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
 * `annotation-supports-hypothesis` edge counts zero whether or not it went; and counting
 * `card_positions` through a join on `links` counts zero as soon as the link is gone, whatever
 * became of the position row.
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
    readonly cardLinkId: string;
    /** Every edge the seed wrote that belongs to the notebook, in the order written. */
    readonly ownedLinkIds: readonly string[];
    /** An edge between two library rows, which must survive. */
    readonly libraryLinkId: string;
  }

  /** A notebook with a day, a claim, a card that has been dragged, and a citation. */
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
    db.board.place(card.id, { x: 120, y: 80 });

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
      cardLinkId: card.id,
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

  it('[I01] removes every edge the notebook owned, named by the ids it wrote', async () => {
    const worked = await workedNotebook('Does spacing beat massing in a 12-layer model?');
    expect(linksById(worked.ownedLinkIds)).toBe(worked.ownedLinkIds.length);
    expect(
      rows('SELECT COUNT(*) AS n FROM card_positions WHERE link_id = @id', {
        id: worked.cardLinkId,
      }),
    ).toBe(1);

    const { removed } = await workspace.call('question:delete', { questionId: worked.notebookId });
    expect(removed).toEqual({ journalDays: 1, hypotheses: 1, cards: 1, links: 4 });

    // The four edges are gone, by id — including the hypothesis one, which is orphaned by the
    // cascade rather than reachable from it, and the day-as-target one the E2E predicate
    // omitted entirely.
    expect(linksById(worked.ownedLinkIds), 'an owned edge outlived its notebook').toBe(0);
    // The desk position, asked about directly rather than through the link it hangs off.
    expect(
      rows('SELECT COUNT(*) AS n FROM card_positions WHERE link_id = @id', {
        id: worked.cardLinkId,
      }),
      'a card position outlived the card',
    ).toBe(0);
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

    await workspace.call('question:delete', { questionId: worked.notebookId });

    expect(linksById(neighbour.ownedLinkIds)).toBe(neighbour.ownedLinkIds.length);
    expect(
      rows('SELECT COUNT(*) AS n FROM card_positions WHERE link_id = @id', {
        id: neighbour.cardLinkId,
      }),
    ).toBe(1);
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
