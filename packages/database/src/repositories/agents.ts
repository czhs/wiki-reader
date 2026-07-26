import type { Database as SqliteDatabase } from 'better-sqlite3';
import { mintId } from '@wr/document-model';
import type { Clock } from '../clock.js';

export type AgentRunStatus = 'running' | 'finished' | 'failed' | 'cancelled';
export type AgentRunTrigger = 'schedule' | 'import' | 'manual';
export type ProposalStatus = 'pending' | 'accepted' | 'rejected';
export type StoredProposalKind = 'connection' | 'contradiction' | 'evidence' | 'direction';

export interface AgentRunRecord {
  readonly id: string;
  readonly agent: 'librarian';
  readonly status: AgentRunStatus;
  readonly capabilities: readonly string[];
  readonly trigger: AgentRunTrigger;
  readonly proposalCount: number;
  readonly summary: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface StoredProposal {
  readonly id: string;
  readonly runId: string;
  readonly kind: StoredProposalKind;
  readonly title: string;
  readonly body: string;
  /** Resolved at the boundary before the row was written. Stored, not re-derived. */
  readonly citations: readonly unknown[];
  readonly covers: readonly unknown[];
  readonly status: ProposalStatus;
  /** Workspace-relative. Present exactly when the proposal was accepted. */
  readonly workspacePath: string | null;
  readonly documentId: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
}

interface RunRow {
  readonly id: string;
  readonly agent: string;
  readonly status: string;
  readonly capabilities: string;
  readonly trigger: string;
  readonly proposal_count: number;
  readonly summary: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
}

interface ProposalRow {
  readonly id: string;
  readonly run_id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly citations_json: string;
  readonly covers_json: string;
  readonly status: string;
  readonly workspace_path: string | null;
  readonly document_id: string | null;
  readonly decided_at: string | null;
  readonly created_at: string;
}

function parseArray(json: string): unknown[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function toRun(row: RunRow): AgentRunRecord {
  return {
    id: row.id,
    agent: 'librarian',
    status: row.status as AgentRunStatus,
    capabilities: parseArray(row.capabilities).filter(
      (value): value is string => typeof value === 'string',
    ),
    trigger: row.trigger as AgentRunTrigger,
    proposalCount: row.proposal_count,
    summary: row.summary,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toProposal(row: ProposalRow): StoredProposal {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind as StoredProposalKind,
    title: row.title,
    body: row.body,
    citations: parseArray(row.citations_json),
    covers: parseArray(row.covers_json),
    status: row.status as ProposalStatus,
    workspacePath: row.workspace_path,
    documentId: row.document_id,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

/**
 * What the librarian produced, and what was decided about it.
 *
 * A run is recorded even when it produces nothing. That is not bookkeeping for its own sake:
 * a pass over unchanged material *should* produce nothing, and the schedule has to be able to
 * tell "ran and found nothing" from "never ran" — which an absence of proposals cannot say.
 */
export class AgentRunsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  start(input: {
    readonly capabilities: readonly string[];
    readonly trigger: AgentRunTrigger;
  }): AgentRunRecord {
    const id = mintId('agentRun');
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, agent, status, capabilities, trigger, proposal_count,
                                 summary, started_at, finished_at)
         VALUES (?, 'librarian', 'running', ?, ?, 0, NULL, ?, NULL)`,
      )
      .run(id, JSON.stringify([...input.capabilities]), input.trigger, this.clock.now());
    const run = this.get(id);
    if (run === null) throw new Error('agentRuns.start: row vanished after insert');
    return run;
  }

  finish(
    id: string,
    input: {
      readonly status: Exclude<AgentRunStatus, 'running'>;
      readonly proposalCount: number;
      readonly summary?: string | null;
    },
  ): AgentRunRecord | null {
    this.db
      .prepare(
        `UPDATE agent_runs
            SET status = ?, proposal_count = ?, summary = ?, finished_at = ?
          WHERE id = ?`,
      )
      .run(input.status, input.proposalCount, input.summary ?? null, this.clock.now(), id);
    return this.get(id);
  }

  get(id: string): AgentRunRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as
      | RunRow
      | undefined;
    return row === undefined ? null : toRun(row);
  }

  /** Most recent first. The scheduler reads the head of this to decide whether it is due. */
  list(limit = 50): AgentRunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_runs ORDER BY started_at DESC, id DESC LIMIT ?')
      .all(limit) as RunRow[];
    return rows.map(toRun);
  }

  latest(): AgentRunRecord | null {
    return this.list(1)[0] ?? null;
  }

  // --- Proposals ----------------------------------------------------------

  propose(input: {
    readonly runId: string;
    readonly kind: StoredProposalKind;
    readonly title: string;
    readonly body: string;
    readonly citations: readonly unknown[];
    readonly covers: readonly unknown[];
  }): StoredProposal {
    const id = mintId('agentProposal');
    this.db
      .prepare(
        `INSERT INTO agent_proposals (id, run_id, kind, title, body, citations_json,
                                      covers_json, status, workspace_path, document_id,
                                      decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?)`,
      )
      .run(
        id,
        input.runId,
        input.kind,
        input.title,
        input.body,
        JSON.stringify([...input.citations]),
        JSON.stringify([...input.covers]),
        this.clock.now(),
      );
    const proposal = this.getProposal(id);
    if (proposal === null) throw new Error('agentRuns.propose: row vanished after insert');
    return proposal;
  }

  getProposal(id: string): StoredProposal | null {
    const row = this.db.prepare('SELECT * FROM agent_proposals WHERE id = ?').get(id) as
      | ProposalRow
      | undefined;
    return row === undefined ? null : toProposal(row);
  }

  listProposals(options: { readonly status?: ProposalStatus; readonly runId?: string } = {}): {
    items: StoredProposal[];
  } {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.status !== undefined) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options.runId !== undefined) {
      clauses.push('run_id = ?');
      params.push(options.runId);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const rows = this.db
      .prepare(`SELECT * FROM agent_proposals ${where} ORDER BY created_at DESC, id DESC`)
      .all(...params) as ProposalRow[];
    return { items: rows.map(toProposal) };
  }

  /**
   * Record that a proposal was accepted, and where it landed.
   *
   * The path is required by the schema, not merely by this signature: accepting *is* writing
   * the file, and a row claiming to be accepted with nothing on disk would be a note the
   * researcher believes is in their wiki and is not.
   */
  accept(id: string, input: { readonly workspacePath: string; readonly documentId?: string | null }): StoredProposal | null {
    this.db
      .prepare(
        `UPDATE agent_proposals
            SET status = 'accepted', workspace_path = ?, document_id = ?, decided_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(input.workspacePath, input.documentId ?? null, this.clock.now(), id);
    return this.getProposal(id);
  }

  reject(id: string): StoredProposal | null {
    this.db
      .prepare(
        `UPDATE agent_proposals
            SET status = 'rejected', decided_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(this.clock.now(), id);
    return this.getProposal(id);
  }
}
