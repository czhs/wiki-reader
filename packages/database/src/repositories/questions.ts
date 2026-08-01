import type { Database as SqliteDatabase } from 'better-sqlite3';
import { mintId } from '@wr/document-model';
import { JOURNAL_ENTITY_SEPARATOR, type Question, type QuestionStatus } from '@wr/shared-types';
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
  /** Where this notebook's calendar begins (`P03`). `null` gives the decision back. */
  readonly journalStart?: string | null | undefined;
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
 * - **Discarding keeps the reason.** The schema itself refuses a discard without a reason, so
 *   there is no path — repository, IPC, or hand-written SQL — that produces a reasonless one.
 * - **Discarding and deleting are different acts** (`I01`). `discard` sets a notebook aside
 *   and `Restore` brings it back with everything it had; `delete` takes the row and everything
 *   that was only ever about it, and there is no undo. This repository will do either, and the
 *   handler above it is what refuses to delete a notebook that was never set aside.
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
                  journal_start = ?, updated_at = ?
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
          patch.journalStart === undefined ? existing.journalStart : patch.journalStart,
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
   * Take a notebook off the shelf for good, and everything that was only ever about it (`I01`).
   *
   * A hard delete, deliberately. `discarded` already is this app's recoverable state — it keeps
   * the reason, and `Restore` brings the notebook back — so a second, softer grave would be a
   * shelf nobody empties. When the researcher says delete, the row goes.
   *
   * What goes with it, and why each:
   *
   * - its **journal**, its **claims** and its **tags**, by `ON DELETE CASCADE` from `questions`.
   *   A day written under a notebook is that notebook's (`P02`); a claim is a sentence on its
   *   page. Neither is addressable once the notebook is not.
   * - every **edge** with the notebook, one of its claims, or one of its days at either end —
   *   which takes its **references**: the papers and highlights it was built from are
   *   `question-references-…` edges, counted separately because they are what the researcher
   *   collected. Deleted by hand because `links` has no foreign key to any of them: the table
   *   is deliberately polymorphic, so nothing in the schema can do this.
   *
   * What does **not** go: the papers, the highlights and the notes those edges pointed at. They
   * are the library. Deleting a line of work must never delete the reading it was done on, and
   * that is the one property of this method worth testing twice.
   */
  delete(id: string): {
    journalDays: number;
    hypotheses: number;
    references: number;
    links: number;
  } {
    const count = (sql: string, params: Record<string, unknown> = { id }): number =>
      (this.db.prepare(sql).get(params) as { n: number } | undefined)?.n ?? 0;

    // The edges to remove, as one predicate used for both the count and the delete: two
    // spellings of "what belongs to this notebook" is how a count comes to disagree with what
    // actually went.
    const prefix = `${id}${JOURNAL_ENTITY_SEPARATOR}`;
    const ownedEdges = `
         (source_type = 'question'   AND source_id = @id)
      OR (target_type = 'question'   AND target_id = @id)
      OR (source_type = 'hypothesis' AND source_id IN (SELECT id FROM hypotheses WHERE question_id = @id))
      OR (target_type = 'hypothesis' AND target_id IN (SELECT id FROM hypotheses WHERE question_id = @id))
      OR (source_type = 'journal'    AND substr(source_id, 1, @prefixLength) = @prefix)
      OR (target_type = 'journal'    AND substr(target_id, 1, @prefixLength) = @prefix)`;
    const edgeParams = { id, prefix, prefixLength: prefix.length };

    const removed = {
      journalDays: count('SELECT COUNT(*) AS n FROM journal_entries WHERE notebook_id = @id'),
      hypotheses: count('SELECT COUNT(*) AS n FROM hypotheses WHERE question_id = @id'),
      references: count(
        `SELECT COUNT(*) AS n FROM links
          WHERE source_type = 'question' AND source_id = @id
            AND type LIKE 'question-references-%'`,
      ),
      links: count(`SELECT COUNT(*) AS n FROM links WHERE ${ownedEdges}`, edgeParams),
    };

    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM links WHERE ${ownedEdges}`).run(edgeParams);
      this.db.prepare('DELETE FROM questions WHERE id = ?').run(id);
    })();

    return removed;
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
