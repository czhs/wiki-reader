import type { Database as SqliteDatabase } from 'better-sqlite3';
import { mintId } from '@wr/document-model';
import type { Question, QuestionStatus } from '@wr/shared-types';
import type { Clock } from '../clock.js';
import { toQuestion, type QuestionRow } from '../mappers.js';
import type { TagsRepository } from './organisation.js';

export interface CreateQuestionInput {
  readonly title: string;
  /** Defaults to `queued`: a new question joins the queue, it does not jump into the work. */
  readonly status?: QuestionStatus | undefined;
  readonly importance?: number | null | undefined;
  readonly nextAction?: string | null | undefined;
}

export interface UpdateQuestionInput {
  readonly title?: string | undefined;
  readonly status?: QuestionStatus | undefined;
  readonly importance?: number | null | undefined;
  readonly nextAction?: string | null | undefined;
  readonly discardedReason?: string | null | undefined;
  readonly description?: string | null | undefined;
  /** Replaces the whole set. Omitted leaves the tags alone. */
  readonly tags?: readonly string[] | undefined;
  /** A row in `document_files`. Never a path — see migration 007. */
  readonly coverFileId?: string | null | undefined;
}

export interface ListQuestionsOptions {
  /** Restrict to these statuses. Omitted means every question, discarded ones included. */
  readonly status?: readonly QuestionStatus[] | undefined;
}

/**
 * The queue: research questions in the order the researcher put them.
 *
 * Two rules the rest of the app depends on:
 *
 * - **Order is stored.** Every read is `ORDER BY ordinal`, and the only thing that changes
 *   an ordinal is `reorder`. No query here sorts by date or importance, because doing so
 *   would replace a judgement about what to do next with a fact about when something was
 *   typed.
 * - **Discarding keeps the reason.** A question is never deleted by this repository. The
 *   schema itself refuses a discard without a reason, so there is no path — repository,
 *   IPC, or hand-written SQL — that produces a reasonless one.
 */
export class QuestionsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
    private readonly tags: TagsRepository,
  ) {}

  create(input: CreateQuestionInput): Question {
    const now = this.clock.now();
    const id = mintId('question');
    const status = input.status ?? 'queued';
    if (status === 'discarded') {
      throw new Error('questions.create: a question cannot start discarded');
    }
    // New questions land at the end. Anywhere else would be the code guessing at a
    // priority the researcher has not expressed yet.
    const ordinal = this.nextOrdinal();
    this.db
      .prepare(
        `INSERT INTO questions
           (id, title, status, ordinal, importance, next_action, discarded_reason,
            started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        status,
        ordinal,
        input.importance ?? null,
        input.nextAction ?? null,
        status === 'active' ? now : null,
        now,
        now,
      );
    const question = this.get(id);
    if (question === null) throw new Error('questions.create: row vanished after insert');
    return question;
  }

  get(id: string): Question | null {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as
      | QuestionRow
      | undefined;
    return row === undefined ? null : toQuestion(row, this.tags.namesForQuestion(id));
  }

  /**
   * The page's prose, as markdown source.
   *
   * Empty means nobody has written on it. The section template is not stored — a blank page
   * looks like the template, which is not the same as the app having written one.
   */
  readBody(id: string): string | null {
    const row = this.db.prepare('SELECT body FROM questions WHERE id = ?').get(id) as
      | { body: string }
      | undefined;
    return row === undefined ? null : row.body;
  }

  /** Store the prose exactly as typed. Nothing here renders, normalises or reflows it. */
  writeBody(id: string, body: string): Question {
    const existing = this.get(id);
    if (existing === null) throw new Error(`questions.writeBody: ${id} not found`);
    this.db
      .prepare('UPDATE questions SET body = ?, updated_at = ? WHERE id = ?')
      .run(body, this.clock.now(), id);
    const updated = this.get(id);
    if (updated === null) throw new Error(`questions.writeBody: ${id} vanished`);
    return updated;
  }

  /** Every question matching `status`, in the hand-arranged order. */
  list(options: ListQuestionsOptions = {}): Question[] {
    const statuses = options.status;
    if (statuses !== undefined && statuses.length === 0) return [];
    const where =
      statuses === undefined
        ? ''
        : `WHERE status IN (${statuses.map(() => '?').join(', ')})`;
    const rows = this.db
      .prepare(`SELECT * FROM questions ${where} ORDER BY ordinal, id`)
      .all(...(statuses ?? [])) as QuestionRow[];
    // One query for every question's tags rather than one per question: the queue is the
    // list that gets drawn on every render.
    const tagRows = this.db
      .prepare(
        `SELECT qt.question_id, t.name FROM question_tags qt
           JOIN tags t ON t.id = qt.tag_id
          ORDER BY t.name`,
      )
      .all() as Array<{ question_id: string; name: string }>;
    const byQuestion = new Map<string, string[]>();
    for (const row of tagRows) {
      const names = byQuestion.get(row.question_id) ?? [];
      names.push(row.name);
      byQuestion.set(row.question_id, names);
    }
    return rows.map((row) => toQuestion(row, byQuestion.get(row.id) ?? []));
  }

  update(id: string, patch: UpdateQuestionInput): Question {
    const existing = this.get(id);
    if (existing === null) throw new Error(`questions.update: ${id} not found`);
    const status = patch.status ?? existing.status;
    const discardedReason =
      patch.discardedReason === undefined ? existing.discardedReason : patch.discardedReason;
    if (status === 'discarded' && (discardedReason === null || discardedReason.trim() === '')) {
      throw new Error('questions.update: discarding a question requires a reason');
    }
    // `started_at` records when work actually began, which is the first time the question
    // became active — not when it was written down, and not again on a later revisit.
    const startedAt =
      existing.startedAt ?? (status === 'active' ? this.clock.now() : null);
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE questions
              SET title = ?, status = ?, importance = ?, next_action = ?,
                  discarded_reason = ?, started_at = ?, description = ?, cover_file_id = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          patch.title ?? existing.title,
          status,
          patch.importance === undefined ? existing.importance : patch.importance,
          patch.nextAction === undefined ? existing.nextAction : patch.nextAction,
          discardedReason,
          startedAt,
          patch.description === undefined ? existing.description : patch.description,
          patch.coverFileId === undefined ? existing.coverFileId : patch.coverFileId,
          this.clock.now(),
          id,
        );
      if (patch.tags !== undefined) this.tags.setQuestionTags(id, patch.tags);
    });
    write();
    const updated = this.get(id);
    if (updated === null) throw new Error(`questions.update: ${id} vanished`);
    return updated;
  }

  /** Drop a question, keeping why. The reason is required; blank is not a reason. */
  discard(id: string, reason: string): Question {
    if (reason.trim() === '') {
      throw new Error('questions.discard: a reason is required');
    }
    return this.update(id, { status: 'discarded', discardedReason: reason });
  }

  /**
   * Rewrite the order of the listed questions.
   *
   * `ids` may be a subset — the queue is usually reordered inside one filtered list — so the
   * ordinals those questions already occupy are collected, sorted, and handed back out in
   * the new order. Questions outside `ids` keep their positions, and a drag inside the
   * active list therefore cannot disturb the queued ones interleaved around it.
   */
  reorder(ids: readonly string[]): Question[] {
    if (ids.length === 0) return [];
    if (new Set(ids).size !== ids.length) {
      throw new Error('questions.reorder: ids contain a duplicate');
    }
    const now = this.clock.now();
    const apply = this.db.transaction((ordered: readonly string[]) => {
      const slots: number[] = [];
      for (const id of ordered) {
        const row = this.db.prepare('SELECT ordinal FROM questions WHERE id = ?').get(id) as
          | { ordinal: number }
          | undefined;
        if (row === undefined) throw new Error(`questions.reorder: ${id} not found`);
        slots.push(row.ordinal);
      }
      slots.sort((a, b) => a - b);
      const write = this.db.prepare(
        'UPDATE questions SET ordinal = ?, updated_at = ? WHERE id = ?',
      );
      ordered.forEach((id, index) => {
        const slot = slots[index];
        if (slot === undefined) throw new Error('questions.reorder: ran out of positions');
        write.run(slot, now, id);
      });
    });
    apply(ids);
    return ids.map((id) => {
      const question = this.get(id);
      if (question === null) throw new Error(`questions.reorder: ${id} vanished`);
      return question;
    });
  }

  private nextOrdinal(): number {
    const row = this.db.prepare('SELECT MAX(ordinal) AS max FROM questions').get() as
      | { max: number | null }
      | undefined;
    return (row?.max ?? -1) + 1;
  }
}
