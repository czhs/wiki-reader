/**
 * Running the librarian (criteria A01, A09, A11).
 *
 * The child process is real. What is replayed is a real recorded `stream-json` transcript, so
 * the argv, the working directory, the pipe, the chunk boundaries and the exit code under test
 * are the ones the app will use in production; only the model's tokens are a recording. The
 * stub writes the argv it was handed to disk, which is how the spawn is *asserted* rather than
 * assumed — a runner that quietly dropped `--system-prompt-file` would otherwise still stream.
 *
 * `A01` is about two things at once: the overriding system prompt, and progress that arrives
 * while the run is happening rather than after it. Both are asserted here.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../apps/desktop/src/main/logger.js';
import { AgentWorkspace } from '../../apps/desktop/src/main/agents/workspace.js';
import { LibrarianRunner, CRAWL_TOOLS } from '../../apps/desktop/src/main/agents/runner.js';
import type { AgentEvent } from '../../apps/desktop/src/main/agents/stream.js';
import { buildLibrarianPrompt } from '../../apps/desktop/src/main/agents/prompt.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'agents');
const FAKE_CLAUDE = join(FIXTURES, 'fake-claude.mjs');

interface RecordedSpawn {
  readonly argv: string[];
  readonly cwd: string;
}

describe('the librarian runner', () => {
  let dir: string;
  let workspace: AgentWorkspace;
  let runner: LibrarianRunner;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wr-librarian-'));
    workspace = new AgentWorkspace({ root: join(dir, 'librarian'), logger: silentLogger });
    runner = new LibrarianRunner({
      workspace,
      logger: silentLogger,
      executable: process.execPath,
      // `node <script>` — the runner passes its arguments after the executable's own, which
      // is exactly the shape a real `claude` invocation has.
      spawn: (command, args, options) =>
        spawn(command, [FAKE_CLAUDE, ...args], {
          cwd: options.cwd,
          env: options.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const spawned = (runDirectory: string): RecordedSpawn =>
    JSON.parse(readFileSync(join(runDirectory, 'spawn-argv.json'), 'utf8')) as RecordedSpawn;

  it('[A01] runs headless under a system prompt that replaces rather than appends', async () => {
    const outcome = await runner.run({
      runId: 'run-a01',
      task: 'Make one pass over the wiki.',
      readRoots: [dir],
    });

    const { argv } = spawned(outcome.directory);

    // The distinction the criterion turns on. `--append-system-prompt` would leave Claude
    // Code's own instructions in front of the librarian's, which is a different agent.
    expect(argv).toContain('--system-prompt-file');
    expect(argv).not.toContain('--append-system-prompt');
    expect(argv).toContain('--print');

    const promptPath = argv[argv.indexOf('--system-prompt-file') + 1];
    expect(promptPath).toBeDefined();
    const prompt = readFileSync(promptPath as string, 'utf8');
    expect(prompt).toBe(buildLibrarianPrompt());
    expect(prompt).toContain('You are the librarian for a personal research wiki.');
    expect(prompt).toContain('You write only in your own workspace');
  });

  it('[A01] streams progress while the run is in flight, not only at the end', async () => {
    // The order of a finished list of events is the same whether they were followed or drained
    // and replayed, so ordering cannot decide this criterion. The child process is the only
    // witness: it pauses mid-transcript and waits for `ackPath`, which the callback below
    // writes on the first event it is handed. A runner that buffered stdout until `close`
    // would leave the child waiting on a file the callback has not run to write.
    const ackPath = join(dir, 'live-ack');
    const live = new LibrarianRunner({
      workspace,
      logger: silentLogger,
      executable: process.execPath,
      spawn: (command, args, options) =>
        spawn(command, [FAKE_CLAUDE, ...args], {
          cwd: options.cwd,
          env: { ...options.env, WR_FAKE_CLAUDE_LIVE_ACK: ackPath },
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
    });

    const arrived: AgentEvent[] = [];
    let finishedSeenAt = -1;

    const outcome = await live.run(
      { runId: 'run-stream', task: 'Make one pass.', readRoots: [dir] },
      (event) => {
        if (arrived.length === 0) writeFileSync(ackPath, event.kind, 'utf8');
        if (event.kind === 'finished') finishedSeenAt = arrived.length;
        arrived.push(event);
      },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);

    // The criterion itself: an event reached the consumer while the process still owed the
    // pipe most of its transcript.
    const handshake = JSON.parse(
      readFileSync(join(outcome.directory, 'live-handshake.json'), 'utf8'),
    ) as { acknowledged: boolean; owedBytes: number };
    expect(handshake.acknowledged).toBe(true);
    expect(handshake.owedBytes).toBeGreaterThan(0);

    // Progress, not just a verdict: the recorded run read and wrote before it answered.
    const kinds = arrived.map((event) => event.kind);
    expect(kinds).toContain('started');
    expect(kinds).toContain('tool');
    expect(kinds).toContain('message');
    expect(kinds).toContain('finished');

    // The terminal event is last — an ordering check, which the handshake above is what backs.
    expect(finishedSeenAt).toBe(arrived.length - 1);
    expect(arrived.length).toBeGreaterThan(10);

    const tools = arrived.filter((event) => event.kind === 'tool');
    expect(tools.length).toBeGreaterThan(3);
    expect(tools.some((event) => event.kind === 'tool' && event.target !== null)).toBe(true);

    expect(outcome.turns).toBeGreaterThan(0);
    expect(outcome.summary.length).toBeGreaterThan(0);
  });

  it('[A01] runs inside its own staging directory and reaches the wiki through --add-dir', async () => {
    const wiki = mkdtempSync(join(tmpdir(), 'wr-wiki-'));
    try {
      const outcome = await runner.run({
        runId: 'run-dirs',
        task: 'Make one pass.',
        readRoots: [wiki],
      });
      const record = spawned(outcome.directory);

      expect(record.cwd).toContain(join('.runs', 'run-dirs'));
      expect(record.argv[record.argv.indexOf('--add-dir') + 1]).toBe(wiki);

      // What the run wrote is in staging, so it is not yet part of the workspace body.
      await expect(workspace.list()).resolves.toEqual([]);
    } finally {
      rmSync(wiki, { recursive: true, force: true });
    }
  });

  it('[A01] reports a non-zero exit as a failed run rather than a silent success', async () => {
    const failing = new LibrarianRunner({
      workspace,
      logger: silentLogger,
      executable: process.execPath,
      spawn: (command, args, options) =>
        spawn(command, [FAKE_CLAUDE, ...args], {
          cwd: options.cwd,
          env: { ...options.env, WR_FAKE_CLAUDE_EXIT: '1', WR_FAKE_CLAUDE_STDERR: 'no auth' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
    });

    const outcome = await failing.run({ runId: 'run-fail', task: 'x', readRoots: [] });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.ok).toBe(false);
  });

  it('[A11] hands the agent a crawl set with no retrieval tool in it', async () => {
    const outcome = await runner.run({ runId: 'run-a11', task: 'x', readRoots: [dir] });
    const { argv } = spawned(outcome.directory);

    const tools = (argv[argv.indexOf('--tools') + 1] ?? '').split(',');
    expect(tools).toEqual([...CRAWL_TOOLS]);
    // Reading, listing and searching text the agent already chose to open — never a ranked
    // set chosen for it, and never the network.
    expect(tools).not.toContain('WebSearch');
    expect(tools).not.toContain('WebFetch');

    // No MCP config accompanies this flag, so it means no MCP servers at all: a retrieval
    // layer cannot arrive through one without the spawn changing.
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).not.toContain('--mcp-config');
  });

  it('[A09] drops the directions line from the prompt when the capability is off', async () => {
    const outcome = await runner.run({
      runId: 'run-a09',
      task: 'x',
      readRoots: [dir],
      capabilities: ['connect', 'contradict', 'evidence'],
    });
    const { argv } = spawned(outcome.directory);
    const prompt = readFileSync(argv[argv.indexOf('--system-prompt-file') + 1] as string, 'utf8');

    expect(prompt).not.toContain('somewhere nobody has gone yet');
    // Switched off means *absent*, not argued against: no sentence forbidding it either.
    expect(prompt.toLowerCase()).not.toContain('do not suggest');
    expect(prompt).toContain('Connect threads across it');
    expect(prompt).toContain('Say plainly where two sources disagree');
  });
});
