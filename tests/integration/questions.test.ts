/**
 * The queue: research questions (criteria Q01, Q03, Q04).
 *
 * Every request crosses the real router with its zod validation into a real SQLite file, and
 * the persistence assertions close the services and reopen them against the same file — an
 * application restart, not a cache flush.
 *
 * Two things here are asserted negatively on purpose, because the positive form of each
 * passes against an implementation that does not have the behaviour:
 *
 * - Order is *stored*. A queue that happened to come back in insertion order would satisfy
 *   "the order survives", so the arrangement asserted here is deliberately not the order the
 *   questions were created in, and not the order any field would sort them into either.
 * - Discarding *keeps the reason*. A test that only reads the reason back would pass on an
 *   implementation where discarding without one is allowed, so the reasonless discard is
 *   asserted to be refused — by the schema, not only by the code above it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AnnotationWithAnchor,
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
    this.dir = mkdtempSync(join(tmpdir(), 'wr-questions-'));
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

const titles = (questions: readonly Question[]): string[] => questions.map((q) => q.title);

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

/** A paper with one highlight on it, created the way the reader creates them. */
async function seedHighlight(title: string): Promise<AnnotationWithAnchor> {
  const document = workspace.services.db.documents.create({
    title,
    docType: 'markdown',
    source: 'corpus',
    authors: [],
  });
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

describe('the queue', () => {
  it('[Q01] keeps a question’s status across a restart', async () => {
    const active = await ask('Do induction heads appear in VLAs?');
    const queued = await ask('Does SDFT preserve induction behaviour?');
    const dropped = await ask('Is the J-space model scaling law real?');

    await workspace.call('question:update', { questionId: active.id, status: 'active' });
    await workspace.call('question:discard', {
      questionId: dropped.id,
      reason: 'answered by Chen et al. before I started',
    });

    workspace.restart();

    const { questions } = await workspace.call('question:list', {});
    const byId = new Map(questions.map((q) => [q.id, q.status]));
    expect(byId.get(active.id)).toBe('active');
    expect(byId.get(queued.id)).toBe('queued');
    expect(byId.get(dropped.id)).toBe('discarded');
  });

  it('[Q01] refuses a status that is not one of the three', async () => {
    const question = await ask('Do induction heads appear in VLAs?');

    const result = await workspace.attempt('question:update', {
      questionId: question.id,
      status: 'parked',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_REQUEST');
  });

  it('[Q01] returns the queue in its stored order, not in insertion order', async () => {
    const first = await ask('First written');
    const second = await ask('Second written');
    const third = await ask('Third written');

    await workspace.call('question:reorder', {
      questionIds: [third.id, first.id, second.id],
    });
    workspace.restart();

    const { questions } = await workspace.call('question:list', {});
    expect(titles(questions)).toEqual(['Third written', 'First written', 'Second written']);
  });

  it('[Q03] keeps the reason and drops out of the working lists', async () => {
    const kept = await ask('Do induction heads appear in VLAs?');
    const dropped = await ask('Does the J-space latent decode to language?');

    const { question } = await workspace.call('question:discard', {
      questionId: dropped.id,
      reason: 'the decoder never converged; not worth more time',
    });
    expect(question.status).toBe('discarded');

    workspace.restart();

    const working = await workspace.call('question:list', { status: ['active', 'queued'] });
    expect(titles(working.questions)).toEqual(['Do induction heads appear in VLAs?']);
    expect(working.questions.map((q) => q.id)).not.toContain(dropped.id);

    // Discarding is not deleting: the question and its reason are still there to read.
    const { question: reread } = await workspace.call('question:get', { questionId: dropped.id });
    expect(reread.discardedReason).toBe('the decoder never converged; not worth more time');
    expect((await workspace.call('question:get', { questionId: kept.id })).question.status).toBe(
      'queued',
    );
  });

  it('[Q03] refuses to discard a question without a reason', async () => {
    const question = await ask('Do induction heads appear in VLAs?');

    const blank = await workspace.attempt('question:discard', {
      questionId: question.id,
      reason: '',
    });
    expect(blank.ok).toBe(false);

    // The other way in is `question:update`, which has no field for a reason at all. It has
    // to refuse rather than write a discarded row with a null reason.
    const sideways = await workspace.attempt('question:update', {
      questionId: question.id,
      status: 'discarded',
    });
    expect(sideways.ok).toBe(false);

    // And the schema underneath refuses it too, so no path — repository, IPC or raw SQL —
    // produces a reasonless discard.
    expect(() =>
      workspace.services.db.sqlite
        .prepare('UPDATE questions SET status = ? WHERE id = ?')
        .run('discarded', question.id),
    ).toThrow();

    expect((await workspace.call('question:get', { questionId: question.id })).question.status).toBe(
      'queued',
    );
  });

  it('[Q04] links to documents and annotations as typed edges', async () => {
    const question = await ask('Do induction heads appear in VLAs?');
    const highlight = await seedHighlight('Anthropic — In-context learning and induction heads');
    const paper = workspace.services.db.documents.create({
      title: 'Olsson et al. — Induction heads',
      docType: 'pdf',
      source: 'zotero',
      authors: [],
    });

    await workspace.call('question:attach', {
      questionId: question.id,
      targetType: 'document',
      targetId: paper.id,
    });
    await workspace.call('question:attach', {
      questionId: question.id,
      targetType: 'annotation',
      targetId: highlight.id,
    });

    workspace.restart();

    // The edges are ordinary rows in `links` — the same table, the same shape, reachable
    // through the same reference query every other entity uses.
    const { links } = await workspace.call('link:findReferences', {
      entityType: 'question',
      entityId: question.id,
      direction: 'outgoing',
    });
    expect(
      links.map((link) => ({ type: link.type, targetType: link.targetType, targetId: link.targetId })),
    ).toEqual(
      expect.arrayContaining([
        { type: 'question-references-document', targetType: 'document', targetId: paper.id },
        {
          type: 'question-references-annotation',
          targetType: 'annotation',
          targetId: highlight.id,
        },
      ]),
    );
    expect(links).toHaveLength(2);
    // Both endpoints resolve, so neither edge is a broken link.
    expect(links.every((link) => !link.broken)).toBe(true);
    expect(links.map((link) => link.otherTitle)).toContain('Olsson et al. — Induction heads');

    // And the question is reachable from the paper, which is what makes it a graph rather
    // than a list of attachments.
    const back = await workspace.call('link:findReferences', {
      entityType: 'document',
      entityId: paper.id,
      direction: 'incoming',
    });
    expect(back.links.map((link) => link.sourceId)).toContain(question.id);
  });

  it('[Q04] refuses an edge to something that is not in the wiki', async () => {
    const question = await ask('Do induction heads appear in VLAs?');

    const result = await workspace.attempt('question:attach', {
      questionId: question.id,
      targetType: 'document',
      targetId: 'doc_00000000000000000000000000',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    const { links } = await workspace.call('link:findReferences', {
      entityType: 'question',
      entityId: question.id,
      direction: 'outgoing',
    });
    expect(links).toEqual([]);
  });
});
