import type { Database as SqliteDatabase } from 'better-sqlite3';
import { mintId } from '@wr/document-model';
import type { Hypothesis, HypothesisStatus } from '@wr/shared-types';
import type { Clock } from '../clock.js';
import { toHypothesis, type HypothesisRow } from '../mappers.js';

export interface CreateHypothesisInput {
  readonly questionId: string;
  readonly statement: string;
  /** Defaults to `open`: a claim nobody has weighed yet is unexamined, not unsupported. */
  readonly status?: HypothesisStatus | undefined;
}

export interface UpdateHypothesisInput {
  readonly statement?: string | undefined;
  readonly status?: HypothesisStatus | undefined;
}

/**
 * The claims on a question's page.
 *
 * There is no evidence table here, and there is not going to be one: evidence is an edge in
 * `links` from the paper or the highlight to the hypothesis, the same table every other
 * relationship in the app uses. A second mechanism would mean a second thing to keep in step
 * with the graph, the reference query and the broken-link check.
 */
export class HypothesesRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  create(input: CreateHypothesisInput): Hypothesis {
    const now = this.clock.now();
    const id = mintId('hypothesis');
    this.db
      .prepare(
        `INSERT INTO hypotheses (id, question_id, statement, status, ordinal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.questionId,
        input.statement,
        input.status ?? 'open',
        this.nextOrdinal(input.questionId),
        now,
        now,
      );
    const created = this.get(id);
    if (created === null) throw new Error('hypotheses.create: row vanished after insert');
    return created;
  }

  get(id: string): Hypothesis | null {
    const row = this.db.prepare('SELECT * FROM hypotheses WHERE id = ?').get(id) as
      | HypothesisRow
      | undefined;
    return row === undefined ? null : toHypothesis(row);
  }

  /** A question's claims, in the order they were put on the page. */
  listForQuestion(questionId: string): Hypothesis[] {
    const rows = this.db
      .prepare('SELECT * FROM hypotheses WHERE question_id = ? ORDER BY ordinal, id')
      .all(questionId) as HypothesisRow[];
    return rows.map(toHypothesis);
  }

  update(id: string, patch: UpdateHypothesisInput): Hypothesis {
    const existing = this.get(id);
    if (existing === null) throw new Error(`hypotheses.update: ${id} not found`);
    this.db
      .prepare('UPDATE hypotheses SET statement = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.statement ?? existing.statement,
        patch.status ?? existing.status,
        this.clock.now(),
        id,
      );
    const updated = this.get(id);
    if (updated === null) throw new Error(`hypotheses.update: ${id} vanished`);
    return updated;
  }

  private nextOrdinal(questionId: string): number {
    const row = this.db
      .prepare('SELECT MAX(ordinal) AS max FROM hypotheses WHERE question_id = ?')
      .get(questionId) as { max: number | null } | undefined;
    return (row?.max ?? -1) + 1;
  }
}
