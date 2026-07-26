/**
 * Putting a pending proposal in front of a running app.
 *
 * A proposal exists because a pass produced one, and a pass needs a model. The recorded
 * transcript in `tests/fixtures/agents` cannot stand in here: it was recorded before the front
 * matter the task now asks for, and it cites the document ids of the library it was recorded
 * against, so replaying it against a fresh workspace yields nothing. What it proves — the
 * argv, the stream, the process lifecycle — is proved in `tests/integration/librarian-run.ts`.
 *
 * So the pass's *output* is staged here instead, through the same code the app uses to read
 * it: written with the real `AgentWorkspace`, harvested by the real `ProposalReader`, and
 * stored with the real repository. Every citation on the row therefore resolved against this
 * database, which is the property `A05` and `A10` then depend on. Nothing is hand-inserted.
 *
 * Runs in the fixture's Node process, before Electron starts, so the two never hold the
 * database open at once.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '@wr/database';
import type { AnnotationAnchor } from '@wr/shared-types';
import { AgentWorkspace } from '../../../apps/desktop/src/main/agents/workspace.js';
import { ProposalReader } from '../../../apps/desktop/src/main/agents/proposals.js';
import { silentLogger } from '../../../apps/desktop/src/main/logger.js';
import type { E2EWorkspace } from './workspace.js';

/** The layout `createAgentServices` uses. Named once so a spec and the app cannot disagree. */
export const librarianRoot = (workspace: E2EWorkspace): string =>
  join(workspace.agentRoot, 'librarian');

export interface StagedProposal {
  readonly id: string;
  readonly title: string;
  /** The entities the boundary resolved, in the order the panel lists them. */
  readonly citations: readonly { readonly entityId: string; readonly title: string }[];
}

export interface StageConnectionInput {
  readonly title: string;
  readonly body: string;
  /** The two threads the connection joins, as entity ids. */
  readonly threads: readonly string[];
}

/**
 * Stage one connection proposal and leave it `pending`.
 *
 * `connection` because it is the kind with the fewest preconditions — two distinct resolvable
 * threads — and the criteria under test are about deciding a proposal, not about which kind it
 * is. The shapes of each kind are asserted in `tests/integration/proposals.test.ts`.
 */
export async function stageConnection(
  workspace: E2EWorkspace,
  input: StageConnectionInput,
): Promise<StagedProposal> {
  const { db } = openDatabase({ file: workspace.databasePath });
  try {
    const run = db.agentRuns.start({ capabilities: ['connect'], trigger: 'manual' });
    const agentWorkspace = new AgentWorkspace({
      root: librarianRoot(workspace),
      logger: silentLogger,
    });
    await agentWorkspace.writeOrThrow(
      join('.runs', run.id, 'proposals', 'finding.md'),
      [
        '---',
        `kind: connection`,
        `title: ${input.title}`,
        `threads: [${input.threads.join(', ')}]`,
        '---',
        '',
        input.body,
        '',
      ].join('\n'),
    );

    const reader = new ProposalReader({ workspace: agentWorkspace, db, logger: silentLogger });
    const harvest = await reader.harvest(run.id, ['connect', 'contradict', 'evidence']);
    const first = harvest.proposals[0];
    if (first === undefined) {
      throw new Error(
        `e2e: the staged proposal was refused: ${harvest.rejected.map((r) => r.reason).join(', ')}`,
      );
    }

    const stored = db.agentRuns.propose({
      runId: run.id,
      kind: first.kind,
      title: first.title,
      body: first.body,
      citations: first.citations,
      covers: first.covers,
    });
    db.agentRuns.finish(run.id, { status: 'finished', proposalCount: 1, summary: null });

    return {
      id: stored.id,
      title: stored.title,
      citations: first.citations.map((citation) => ({
        entityId: citation.entityId,
        title: citation.title,
      })),
    };
  } finally {
    db.close();
  }
}

/**
 * A highlight on a page other than the first, so "opens its source" and "opens its source *at
 * its location*" are distinguishable outcomes.
 *
 * The anchor carries text evidence the way a real one does. Whether the quote re-matches in
 * the rendered page is `M11`'s business; what this is for is a citation whose location names
 * a page the reader has to scroll to.
 */
export function seedHighlight(
  workspace: E2EWorkspace,
  input: {
    readonly documentId: string;
    readonly pageIndex: number;
    readonly text: string;
  },
): string {
  const { db } = openDatabase({ file: workspace.databasePath });
  try {
    const anchor: AnnotationAnchor = {
      kind: 'pdf',
      version: 1,
      pageIndex: input.pageIndex,
      rects: [{ x1: 0.1, y1: 0.2, x2: 0.7, y2: 0.24 }],
      quote: { exact: input.text, prefix: '', suffix: '' },
      position: { start: 0, end: input.text.length },
      pageTextHash: 'e2e-page-text-hash',
      contentHash: 'e2e-content-hash',
    };
    return db.annotations.create({
      documentId: input.documentId,
      kind: 'highlight',
      color: 'yellow',
      selectedText: input.text,
      anchor,
    }).id;
  } finally {
    db.close();
  }
}

/** What the librarian has actually written into its workspace body, as relative paths. */
export function librarianNotes(workspace: E2EWorkspace): string[] {
  try {
    return readdirSync(join(librarianRoot(workspace), 'notes')).sort();
  } catch {
    // No `notes` directory at all is the correct state before anything has been accepted.
    return [];
  }
}
