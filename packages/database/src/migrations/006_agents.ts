/**
 * Migration 006 — what the librarian produced, and what was done about it.
 *
 * The librarian proposes; nothing it writes lands without an explicit accept. Two tables carry
 * that: a run, and the proposals it staged.
 *
 * `agent_runs.proposal_count` records nothing as a *number* rather than leaving it to be
 * inferred from an absence of rows. A pass over unchanged material that produces nothing is
 * the correct outcome, not a failure, and the two have to be distinguishable afterwards —
 * otherwise "the run found nothing" and "the run never happened" look the same in the history,
 * and the schedule cannot tell whether it is due.
 *
 * The CHECK on `agent_proposals` refuses an accepted row with no path. Accepting *is* writing
 * the file: a row that claimed to be accepted while nothing had landed in the workspace would
 * be a proposal the researcher believes they have in their wiki and does not.
 *
 * Citations are stored resolved. Resolution happened at the boundary, before the proposal was
 * shown to anyone; this column is the record of what resolved, not a second chance to resolve.
 */

export const MIGRATION_006_AGENTS = `
CREATE TABLE agent_runs (
  id             TEXT PRIMARY KEY,
  agent          TEXT NOT NULL CHECK (agent IN ('librarian')),
  status         TEXT NOT NULL CHECK (status IN ('running', 'finished', 'failed', 'cancelled')),
  -- The capability set this pass actually ran with, so a proposal can be read back against
  -- the remit that produced it rather than against whatever the setting says today.
  capabilities   TEXT NOT NULL,
  trigger        TEXT NOT NULL CHECK (trigger IN ('schedule', 'import', 'manual')),
  proposal_count INTEGER NOT NULL DEFAULT 0 CHECK (proposal_count >= 0),
  summary        TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);

CREATE INDEX agent_runs_started_idx ON agent_runs(started_at DESC);

CREATE TABLE agent_proposals (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL
                 CHECK (kind IN ('connection', 'contradiction', 'evidence', 'direction')),
  title          TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body           TEXT NOT NULL CHECK (length(trim(body)) > 0),
  citations_json TEXT NOT NULL,
  covers_json    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  -- Where accepting put it, relative to the workspace root. Never an absolute path: the
  -- workspace can move, and a row that named a machine would not survive the move.
  workspace_path TEXT,
  document_id    TEXT REFERENCES documents(id) ON DELETE SET NULL,
  decided_at     TEXT,
  created_at     TEXT NOT NULL,
  CHECK (status <> 'accepted' OR workspace_path IS NOT NULL),
  CHECK (status = 'pending' OR decided_at IS NOT NULL)
);

CREATE INDEX agent_proposals_run_idx    ON agent_proposals(run_id, created_at);
CREATE INDEX agent_proposals_status_idx ON agent_proposals(status, created_at DESC);
`;
