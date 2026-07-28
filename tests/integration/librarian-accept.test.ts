/**
 * Accepting and rejecting what the librarian proposed (criteria A05, A12, A13).
 *
 * The whole arrangement turns on the accept. A wiki that accumulates unread machine output is
 * a log, not a wiki — so a run stages, the boundary filters, and the rows land as `pending`.
 * Accepting is the only code path that puts a file where the researcher will read it, and
 * rejecting has to leave the workspace exactly as it found it. Both are asserted against the
 * directory itself, not against a status column: a row that says `rejected` while a file sits
 * on disk is the failure this is looking for.
 *
 * `A13`'s second half is here too, from the side that can be tested without waiting twelve
 * hours: a pass that finds nothing writes nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServices, type AppServices } from '../../apps/desktop/src/main/services.js';
import { silentLogger } from '../../apps/desktop/src/main/logger.js';
import {
  AgentWorkspace,
  type WorkspaceWrite,
} from '../../apps/desktop/src/main/agents/workspace.js';
import { WikiView } from '../../apps/desktop/src/main/agents/wiki-view.js';
import { LibrarianRunner } from '../../apps/desktop/src/main/agents/runner.js';
import { ProposalReader, splitFrontMatter } from '../../apps/desktop/src/main/agents/proposals.js';
import { LibrarianService } from '../../apps/desktop/src/main/agents/librarian.js';

const FAKE_CLAUDE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'agents',
  'fake-claude.mjs',
);

/**
 * A workspace that suspends the *first* writer until the test lets it go.
 *
 * The accept path's race window opens when a caller returns from its write holding a path and
 * closes when it has registered the document. Left to the filesystem, whether a second caller
 * gets inside that window is timing — it reproduced three times in six — and a guard a test
 * exercises half the time is one a later change can delete with nothing going red.
 *
 * Only the first write is held, deliberately. A counting barrier would deadlock against the
 * fix: once the second accept joins the first instead of repeating it there is no second
 * write to arrive, and a harness that hangs when the bug is gone is a harness that encodes
 * the bug. Nothing here changes what `AgentWorkspace` does — only when it returns.
 */
class GatedWorkspace extends AgentWorkspace {
  #open: (() => void) | null = null;
  #arrived = 0;
  #watchers: { readonly count: number; readonly resolve: () => void }[] = [];

  readonly #released: Promise<void>;

  constructor(options: ConstructorParameters<typeof AgentWorkspace>[0]) {
    super(options);
    this.#released = new Promise<void>((resolve) => {
      this.#open = resolve;
    });
  }

  /** Resolves once `count` writers are suspended inside the window together. */
  arrived(count: number): Promise<void> {
    if (this.#arrived >= count) return Promise.resolve();
    return new Promise<void>((resolve) => this.#watchers.push({ count, resolve }));
  }

  release(): void {
    this.#open?.();
  }

  override async write(requested: string, contents: string): Promise<WorkspaceWrite> {
    const written = await super.write(requested, contents);
    this.#arrived += 1;
    for (const watcher of this.#watchers.filter((w) => w.count <= this.#arrived)) {
      watcher.resolve();
    }
    // Every writer waits, so releasing them puts them all in the window in subscription
    // order rather than in whatever order the filesystem happened to finish them.
    await this.#released;
    return written;
  }
}

describe('accepting what the librarian proposed', () => {
  let dir: string;
  let services: AppServices;
  let workspace: AgentWorkspace;
  let view: WikiView;
  let librarian: LibrarianService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wr-accept-'));
    services = createTestServices({
      databasePath: join(dir, 'wiki-reader.db'),
      zoteroDataDir: join(dir, 'zotero'),
      logger: silentLogger,
    });
    workspace = new AgentWorkspace({ root: join(dir, 'librarian'), logger: silentLogger });
    view = new WikiView({ db: services.db, root: join(dir, 'wiki'), logger: silentLogger });
    librarian = new LibrarianService({
      db: services.db,
      workspace,
      view,
      logger: silentLogger,
      runner: new LibrarianRunner({
        workspace,
        logger: silentLogger,
        executable: process.execPath,
        spawn: (command, args, options) =>
          spawn(command, [FAKE_CLAUDE, ...args], {
            cwd: options.cwd,
            env: options.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
      }),
      reader: new ProposalReader({ workspace, db: services.db, logger: silentLogger }),
    });
  });

  afterEach(async () => {
    await view.remove();
    services.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const paper = (title: string): string =>
    services.db.documents.create({ title, docType: 'pdf', source: 'zotero' }).id;

  /** Stage a proposal the way a run does, then harvest it into a pending row. */
  const propose = async (front: string, body: string): Promise<string> => {
    const run = services.db.agentRuns.start({ capabilities: ['connect'], trigger: 'manual' });
    await workspace.writeOrThrow(
      join('.runs', run.id, 'proposals', 'finding.md'),
      `---\n${front}\n---\n\n${body}\n`,
    );
    const reader = new ProposalReader({ workspace, db: services.db, logger: silentLogger });
    const harvest = await reader.harvest(run.id, ['connect', 'contradict', 'evidence']);
    expect(harvest.proposals).toHaveLength(1);
    const first = harvest.proposals[0];
    if (first === undefined) throw new Error('nothing harvested');
    return services.db.agentRuns.propose({
      runId: run.id,
      kind: first.kind,
      title: first.title,
      body: first.body,
      citations: first.citations,
      covers: first.covers,
    }).id;
  };

  it('[A05] accepting writes the proposal into the workspace as markdown with wikilinks', async () => {
    const a = paper('Scaling monosemanticity');
    const b = paper('Feature splitting is an artefact');
    const proposalId = await propose(
      `kind: connection\ntitle: Two readings of the same sweep\nthreads: [${a}, ${b}]`,
      `Both describe one width sweep and disagree about what it shows.`,
    );

    await expect(workspace.list()).resolves.toEqual([]);

    const { path } = await librarian.accept(proposalId);
    const written = await readFile(path, 'utf8');

    expect(written).toContain('Two readings of the same sweep');
    expect(written).toContain(`[[${a}]]`);
    expect(written).toContain(`[[${b}]]`);
    expect(written).toContain('source: librarian');

    // In the workspace body now, not in staging.
    const body = await workspace.list();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatch(/^notes\//);

    const stored = services.db.agentRuns.getProposal(proposalId);
    expect(stored?.status).toBe('accepted');
    expect(stored?.workspacePath).toBe(body[0]);
  });

  it('[A05] rejecting writes nothing at all', async () => {
    const a = paper('One');
    const b = paper('Two');
    const proposalId = await propose(
      `kind: connection\ntitle: Not worth keeping\nthreads: [${a}, ${b}]`,
      'A thin observation.',
    );

    const before = services.db.documents.list({ limit: 100 }).total;
    librarian.reject(proposalId);

    // The directory is the assertion, not the status column: a row saying `rejected` while a
    // file sits on disk is exactly the failure worth catching.
    await expect(workspace.list()).resolves.toEqual([]);
    expect(services.db.documents.list({ limit: 100 }).total).toBe(before);

    const stored = services.db.agentRuns.getProposal(proposalId);
    expect(stored?.status).toBe('rejected');
    expect(stored?.workspacePath).toBeNull();
  });

  it('[A05] refuses to decide the same proposal twice', async () => {
    const proposalId = await propose(
      `kind: connection\ntitle: Decided once\nthreads: [${paper('A')}, ${paper('B')}]`,
      'Body.',
    );

    librarian.reject(proposalId);
    await expect(librarian.accept(proposalId)).rejects.toThrow(/already rejected/);
    await expect(workspace.list()).resolves.toEqual([]);
  });

  /**
   * Audit finding 3. The test above is sequential, and sequential is the easy case. Two
   * clicks on Accept dispatch two concurrent invokes — `ipcRenderer.invoke` does not
   * serialise — and the pending check is separated from the state change by two awaits, so
   * both callers pass it. The proposal row survives that on its own (`WHERE status =
   * 'pending'`). `documents.create` does not: `documents_slug_idx` is not unique, so the
   * second insert lands, and `upsertByPath` then repoints the single file row at whichever
   * finished last — leaving a librarian document with a title, a slug and citation edges but
   * no file behind it, visible in the library and in the graph, and unopenable.
   */
  it('[A05] mints one document when the same proposal is accepted twice at once', async () => {
    const a = paper('Scaling monosemanticity');
    const proposalId = await propose(
      `kind: connection\ntitle: Accepted twice at once\nthreads: [${a}, ${paper('Other')}]`,
      `Turning on [[${a}]].`,
    );
    const before = services.db.documents.list({ limit: 200 }).total;

    const gated = new GatedWorkspace({ root: workspace.root, logger: silentLogger });
    const racing = new LibrarianService({
      db: services.db,
      workspace: gated,
      view,
      logger: silentLogger,
      runner: new LibrarianRunner({ workspace: gated, logger: silentLogger }),
      reader: new ProposalReader({ workspace: gated, db: services.db, logger: silentLogger }),
    });

    // The first accept is suspended holding a written path and no document yet. The second
    // arrives while it is there — which is what two clicks on Accept do.
    const first = racing.accept(proposalId);
    await gated.arrived(1);
    const second = racing.accept(proposalId);

    // Wait for a second writer if one is coming. When the accept is guarded there is no
    // second write at all, so the timeout is the path taken and the test is fast; when it is
    // not, both are held and released together, which is the window under test.
    await Promise.race([
      gated.arrived(2),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
    gated.release();

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);

    expect(services.db.documents.list({ limit: 200 }).total - before).toBe(1);
    await expect(workspace.list()).resolves.toHaveLength(1);

    // Every document the accept created must still have its file; an orphan is the defect.
    const stored = services.db.agentRuns.getProposal(proposalId);
    const documentId = stored?.documentId ?? '';
    expect(services.db.files.listByDocument(documentId)).toHaveLength(1);

    // And the citation is one edge, not two.
    const edges = services.db.links.findReferences({
      entityType: 'document',
      entityId: documentId,
      direction: 'outgoing',
    });
    expect(edges.filter((edge) => edge.targetId === a)).toHaveLength(1);
  });

  it('[A12] the accepted note records the documents it covers, and they resolve', async () => {
    const a = paper('First paper');
    const b = paper('Second paper');
    const proposalId = await propose(
      `kind: connection\ntitle: A map of the sweep\nthreads: [${a}, ${b}]\ncovers: [${a}, ${b}]`,
      `The sweep runs through [[${a}]] and [[${b}]].`,
    );

    const { path } = await librarian.accept(proposalId);
    const { front } = splitFrontMatter(await readFile(path, 'utf8'));

    // Recorded: in the note itself, where a later pass reads it to decide whether the map is
    // enough or the sources are needed.
    expect(front.get('covers')).toEqual([a, b]);

    // And they resolve — which is the half that fails silently, because a list of ids is not
    // a list of documents.
    for (const id of front.get('covers') ?? []) {
      expect(services.db.documents.getById(id)?.id).toBe(id);
    }
  });

  it('[A12] the accepted note becomes a wiki document whose citations are real edges', async () => {
    const a = paper('Cited paper');
    const proposalId = await propose(
      `kind: connection\ntitle: An edge to a paper\nthreads: [${a}, ${paper('Other')}]`,
      `Turning on [[${a}]].`,
    );

    await librarian.accept(proposalId);

    const stored = services.db.agentRuns.getProposal(proposalId);
    expect(stored?.documentId).not.toBeNull();
    const note = services.db.documents.getById(stored?.documentId ?? '');
    expect(note?.source).toBe('librarian');

    const edges = services.db.links.findReferences({
      entityType: 'document',
      entityId: stored?.documentId ?? '',
      direction: 'outgoing',
    });
    expect(edges.map((edge) => edge.targetId)).toContain(a);
    expect(edges.every((edge) => edge.type === 'librarian-note-cites')).toBe(true);
  });

  it('[A13] a pass that finds nothing writes nothing, and is still recorded as having run', async () => {
    paper('Something to read');

    // The recorded transcript writes a note into the run directory but stages no proposal,
    // which is exactly the shape of a pass that turned nothing up.
    const pass = await librarian.pass({ trigger: 'schedule' });

    expect(pass.proposals).toEqual([]);
    await expect(workspace.list()).resolves.toEqual([]);
    expect(services.db.documents.list({ limit: 100 }).items.every((d) => d.source !== 'librarian')).toBe(
      true,
    );

    // "Ran and found nothing" and "never ran" are different facts, and the schedule needs to
    // tell them apart — so the run is recorded with a count of zero rather than not at all.
    const latest = services.db.agentRuns.latest();
    expect(latest?.id).toBe(pass.run.id);
    expect(latest?.proposalCount).toBe(0);
    expect(latest?.status).toBe('finished');
    expect(latest?.trigger).toBe('schedule');
  });
});
