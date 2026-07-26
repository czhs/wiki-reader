/**
 * The librarian as the app reaches it (criteria A03, A05, A09, A13).
 *
 * Every module under `main/agents` was already tested on its own. What was untested is the
 * part that matters most for `A03`: whether the *assembled application* leaves them alone
 * until somebody says otherwise. A workspace, a view, a runner and a scheduler that are
 * constructed on startup are harmless; a view that is materialised or a timer that is started
 * is not, because both happen before any disclosure has been read.
 *
 * So the assertions here are about absence as much as presence. With agents off: no wiki on
 * disk, no run recorded, no pass due, and a `agent:run` that is refused rather than obeyed.
 * Asking for the status and asking for the disclosure — the two things an interface does
 * before anything is enabled — must leave all of that still true.
 *
 * The child process is real; only the model's tokens are replayed from a recording.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcChannel, IpcRequest, IpcResponse } from '@wr/shared-types';
import { createTestServices, type AppServices } from '../../apps/desktop/src/main/services.js';
import { createHandlers } from '../../apps/desktop/src/main/handlers.js';
import { dispatch } from '../../apps/desktop/src/main/router.js';
import { silentLogger } from '../../apps/desktop/src/main/logger.js';

const FAKE_CLAUDE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'agents',
  'fake-claude.mjs',
);

class Harness {
  readonly dir: string;
  readonly databasePath: string;
  readonly agentRoot: string;
  private current: AppServices;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'wr-agent-channels-'));
    this.databasePath = join(this.dir, 'wiki-reader.db');
    this.agentRoot = join(this.dir, 'agent');
    this.current = this.open();
  }

  private open(): AppServices {
    return createTestServices({
      databasePath: this.databasePath,
      zoteroDataDir: join(this.dir, 'zotero'),
      agentRoot: this.agentRoot,
      agentExecutable: process.execPath,
      agentSpawn: (command, args, options) =>
        spawn(command, [FAKE_CLAUDE, ...args], {
          cwd: options.cwd,
          env: options.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
    });
  }

  get services(): AppServices {
    return this.current;
  }

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

  async attempt(channel: string, request: unknown): Promise<ReturnType<typeof dispatch>> {
    return dispatch(createHandlers(this.current), channel, request, silentLogger);
  }

  async dispose(): Promise<void> {
    // The view seals its own tree read-only, so it owns removing it; a plain rm gets EACCES.
    await this.current.agents.view.remove();
    this.current.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

let harness: Harness;

beforeEach(() => {
  harness = new Harness();
});

afterEach(async () => {
  await harness.dispose();
});

/**
 * Stage a proposal the way a finished pass leaves one behind.
 *
 * Written through the real workspace and read back through the real `ProposalReader`, so the
 * citations on the row are ones that were resolved against this database — which is what the
 * channels under test are then asked to hand to an interface. The recorded transcript cannot
 * stand in here: it was recorded before the front matter the task now asks for, and it cites
 * the ids of the library it was recorded against.
 */
async function stage(
  services: AppServices,
  front: string,
  body: string,
): Promise<string> {
  const run = services.db.agentRuns.start({ capabilities: ['connect'], trigger: 'manual' });
  await services.agents.workspace.writeOrThrow(
    join('.runs', run.id, 'proposals', 'finding.md'),
    `---\n${front}\n---\n\n${body}\n`,
  );
  const harvest = await services.agents.reader.harvest(run.id, [
    'connect',
    'contradict',
    'evidence',
  ]);
  const first = harvest.proposals[0];
  if (first === undefined) throw new Error('nothing harvested from the staged proposal');
  return services.db.agentRuns.propose({
    runId: run.id,
    kind: first.kind,
    title: first.title,
    body: first.body,
    citations: first.citations,
    covers: first.covers,
  }).id;
}

/** A wiki with something in it, so the disclosure has non-zero counts to report. */
function seed(services: AppServices): string {
  const paper = services.db.documents.create({
    title: 'Induction heads in small transformers',
    docType: 'pdf',
    source: 'zotero',
  });
  services.db.questions.create({ title: 'Do induction heads explain in-context learning?' });
  services.db.journal.write('2026-07-20', 'Read the induction-head paper.');
  return paper.id;
}

describe('the librarian over IPC', () => {
  it('[A03] is off until it is enabled, and asking about it starts nothing', async () => {
    seed(harness.services);

    const status = await harness.call('agent:status', {});
    expect(status.enabled).toBe(false);
    expect(status.disclosureAcknowledged).toBe(false);
    expect(status.running).toBe(false);
    expect(status.lastRun).toBeNull();

    // Asking what would be sent must not send it: the disclosure is computed from the
    // database, and materialising the view to answer would make "off" untrue on first paint.
    const disclosure = await harness.call('agent:disclosure', {});
    expect(disclosure.agent).toBe('librarian');
    expect(disclosure.acknowledged).toBe(false);

    expect(existsSync(harness.services.agents.view.root)).toBe(false);
    expect(harness.services.db.agentRuns.list()).toHaveLength(0);

    // And nothing is scheduled. The timer is not merely idle — it was never started.
    const decision = await harness.services.agents.scheduler.tick();
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe('disabled');
    expect(harness.services.db.agentRuns.list()).toHaveLength(0);
  });

  it('[A03] refuses to run a pass while agents are off', async () => {
    const refused = await harness.attempt('agent:run', {});
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.error.code).toBe('CONFLICT');
    expect(harness.services.db.agentRuns.list()).toHaveLength(0);
    expect(existsSync(harness.services.agents.view.root)).toBe(false);
  });

  it('[A03] refuses to enable until the disclosure has been acknowledged', async () => {
    const refused = await harness.attempt('agent:enable', { enabled: true });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.error.code).toBe('CONFLICT');

    expect((await harness.call('agent:status', {})).enabled).toBe(false);
  });

  it('[A03] discloses what a run would send, counted from the wiki itself', async () => {
    seed(harness.services);
    const disclosure = await harness.call('agent:disclosure', {});

    const documents = disclosure.sends.find((item) => item.what.includes('documents'));
    expect(documents?.count).toBe(1);
    const questions = disclosure.sends.find((item) => item.what.includes('questions'));
    expect(questions?.count).toBe(1);
    const journal = disclosure.sends.find((item) => item.what.includes('journal'));
    expect(journal?.count).toBe(1);

    // Where it goes and whose credentials pay for it, both named rather than implied.
    expect(disclosure.destination).toContain('Anthropic');
    expect(disclosure.credentials.length).toBeGreaterThan(0);
    // No web tool and no MCP server: what it cannot do is part of what is being disclosed.
    expect(disclosure.tools).not.toContain('WebFetch');
    expect(disclosure.withholds.length).toBeGreaterThan(0);
    expect(disclosure.capabilities.map((capability) => capability.id)).toContain('directions');
  });

  it('[A03] stays enabled across a restart once the disclosure has been accepted', async () => {
    const enabled = await harness.call('agent:enable', {
      enabled: true,
      acknowledgeDisclosure: true,
    });
    expect(enabled.enabled).toBe(true);
    expect(enabled.disclosureAcknowledged).toBe(true);

    harness.restart();

    const after = await harness.call('agent:status', {});
    expect(after.enabled).toBe(true);
    // Acknowledged once, not once per launch.
    expect(after.disclosureAcknowledged).toBe(true);
    expect((await harness.call('agent:disclosure', {})).acknowledged).toBe(true);
  });

  it('[A09] remembers which capabilities are switched off, and says so in the disclosure', async () => {
    const status = await harness.call('agent:setCapabilities', {
      capabilities: ['connect', 'contradict', 'evidence'],
    });
    expect(status.capabilities).not.toContain('directions');

    harness.restart();

    const disclosure = await harness.call('agent:disclosure', {});
    const directions = disclosure.capabilities.find((capability) => capability.id === 'directions');
    expect(directions?.enabled).toBe(false);
    expect(directions?.core).toBe(false);
  });

  it('[A13] runs a pass once agents are on, and schedules the next one itself', async () => {
    seed(harness.services);
    await harness.call('agent:enable', { enabled: true, acknowledgeDisclosure: true });

    // Never run before, so the first consideration is due — and the pass it starts is real.
    const decision = await harness.services.agents.scheduler.tick();
    expect(decision.due).toBe(true);
    expect(decision.reason).toBe('never-run');

    const runs = harness.services.db.agentRuns.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe('schedule');
    expect(runs[0]?.status).not.toBe('running');

    // Having just run, it is not due again.
    const second = await harness.services.agents.scheduler.tick();
    expect(second.due).toBe(false);
    expect(second.reason).toBe('not-due');
    expect(harness.services.db.agentRuns.list()).toHaveLength(1);
  });

  it('[A05] lists a pending proposal, accepts it onto disk, and rejects one to nothing', async () => {
    const a = seed(harness.services);
    const b = harness.services.db.documents.create({
      title: 'Feature splitting is an artefact of the width sweep',
      docType: 'pdf',
      source: 'zotero',
    }).id;
    const keep = await stage(
      harness.services,
      `kind: connection\ntitle: Two readings of one sweep\nthreads: [${a}, ${b}]`,
      `Both describe the same sweep and disagree about what it shows: [[${a}]] and [[${b}]].`,
    );
    const drop = await stage(
      harness.services,
      `kind: connection\ntitle: Not worth keeping\nthreads: [${a}, ${b}]`,
      'A thin observation.',
    );

    const pending = await harness.call('agent:listProposals', { status: 'pending', limit: 100 });
    expect(pending.proposals.map((proposal) => proposal.id).sort()).toEqual([keep, drop].sort());
    expect((await harness.call('agent:status', {})).pendingProposals).toBe(2);

    const accepted = await harness.call('agent:accept', { proposalId: keep });
    expect(accepted.proposal.status).toBe('accepted');
    expect(accepted.proposal.documentId).not.toBeNull();

    // Accepted means on disk, in the workspace, and readable as the note it claims to be.
    const workspaceRoot = harness.services.agents.workspace.root;
    const notes = (await harness.services.agents.workspace.list()).filter((entry) =>
      entry.startsWith(`notes${sep}`),
    );
    expect(notes).toHaveLength(1);
    const written = await readFile(join(workspaceRoot, notes[0] as string), 'utf8');
    expect(written).toContain('Two readings of one sweep');
    expect(written).toContain(`[[${a}]]`);

    // And the accepted note is servable through `rrfile://`, which means the workspace has to
    // be one of the roots the app is willing to read from.
    expect(harness.services.allowed.roots.some((root) => workspaceRoot.startsWith(root))).toBe(
      true,
    );

    // Rejecting writes nothing: the directory is the assertion, not the status column.
    const before = await harness.services.agents.workspace.list();
    const rejected = await harness.call('agent:reject', { proposalId: drop });
    expect(rejected.proposal.status).toBe('rejected');
    expect(await harness.services.agents.workspace.list()).toEqual(before);
    expect((await harness.call('agent:status', {})).pendingProposals).toBe(0);
  });

  it('[A05] refuses to decide a proposal twice', async () => {
    const a = seed(harness.services);
    const b = harness.services.db.documents.create({
      title: 'Second paper',
      docType: 'pdf',
      source: 'zotero',
    }).id;
    const proposalId = await stage(
      harness.services,
      `kind: connection\ntitle: Decided once\nthreads: [${a}, ${b}]`,
      'Body.',
    );

    await harness.call('agent:reject', { proposalId });
    const again = await harness.attempt('agent:accept', { proposalId });
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.error.code).toBe('CONFLICT');
    await expect(harness.services.agents.workspace.list()).resolves.toEqual([]);
  });

  it('[A10] gives every citation the document it is in, so the interface can open it', async () => {
    const a = seed(harness.services);
    const b = harness.services.db.documents.create({
      title: 'Second paper',
      docType: 'pdf',
      source: 'zotero',
    }).id;
    await stage(
      harness.services,
      `kind: connection\ntitle: A citation that opens\nthreads: [${a}, ${b}]`,
      `Turning on [[${a}]] and [[${b}]].`,
    );

    const pending = await harness.call('agent:listProposals', { status: 'pending', limit: 100 });
    const cited = pending.proposals.flatMap((proposal) => proposal.citations);
    expect(cited.map((citation) => citation.entityId).sort()).toEqual([a, b].sort());
    for (const citation of cited) {
      expect(citation.title.length).toBeGreaterThan(0);
      // Resolved at the boundary, so there is nothing here that cannot be opened.
      expect(citation.documentId).toBe(citation.entityId);
    }
  });
});
