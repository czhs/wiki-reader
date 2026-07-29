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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blankNotebook, notebookSections } from '@wr/document-model';
import type {
  AnnotationWithAnchor,
  Document,
  IpcChannel,
  IpcRequest,
  IpcResponse,
  MarkdownAnchor,
  Question,
} from '@wr/shared-types';
import { createTestServices, type AppServices } from '../../apps/desktop/src/main/services.js';
import { createHandlers } from '../../apps/desktop/src/main/handlers.js';
import { dispatch } from '../../apps/desktop/src/main/router.js';
import { silentLogger } from '../../apps/desktop/src/main/logger.js';

class Workspace {
  readonly dir: string;
  readonly databasePath: string;
  private current: AppServices;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'wr-notebook-'));
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

  /** Close everything and reopen against the same file — an application restart. */
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

  /** The raw envelope, for the cases where the refusal *is* the assertion. */
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

async function ask(title: string): Promise<Question> {
  const { question } = await workspace.call('question:create', { title });
  return question;
}

const QUOTE = 'Induction heads copy the token that followed the previous occurrence.';

function markdownAnchor(): MarkdownAnchor {
  return {
    kind: 'markdown',
    version: 1,
    quote: { exact: QUOTE, prefix: '', suffix: '' },
    position: { start: 0, end: QUOTE.length },
    documentTextHash: 'text-hash',
    sourceHash: 'source-hash',
    normalizationVersion: 1,
  };
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
    selectedText: QUOTE,
    comment: null,
    anchor: markdownAnchor(),
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
