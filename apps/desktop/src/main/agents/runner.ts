/**
 * Running the librarian: a headless `claude`, watched while it works.
 *
 * Four spawn decisions carry the milestone's rules and none of them are incidental.
 *
 * `--system-prompt-file` **replaces** the default system prompt, where `--append-system-prompt`
 * would leave Claude Code's own instructions in front of ours. The librarian is not Claude Code
 * with a note attached; it is a different agent, and `A01` asserts the overriding form.
 *
 * `--output-format stream-json` is what makes the run observable. A `--print` run is a black
 * box that answers minutes later, which is indistinguishable from a hang and impossible to
 * cancel meaningfully.
 *
 * `--tools` names the crawl set and nothing else: read, glob, grep, and writing inside the run
 * directory. There is no web tool and, with `--strict-mcp-config` and no config, no MCP server
 * — so there is no retrieval anywhere in the path (`A11`), by construction rather than by
 * intention.
 *
 * The working directory is the run's staging directory and the only place the process is given
 * write access to. The wiki arrives through `--add-dir`, which the second half of the boundary
 * (`AgentWorkspace`) re-checks anyway: nothing this process produces lands in the workspace
 * body without an accept.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';
import {
  buildLibrarianPrompt,
  DEFAULT_CAPABILITIES,
  type LibrarianCapability,
} from './prompt.js';
import { LineSplitter, parseStreamLine, type AgentEvent } from './stream.js';
import type { AgentWorkspace } from './workspace.js';
import type { Logger } from '../logger.js';

/** The only tools the librarian is given. Adding a retrieval tool here would undo `A11`. */
export const CRAWL_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit'] as const;

/** The subset of a child process this module uses. Narrow so a test can supply one. */
export interface SpawnedAgent {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type AgentSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => SpawnedAgent;

export interface LibrarianRunnerOptions {
  readonly workspace: AgentWorkspace;
  readonly logger: Logger;
  /** The `claude` executable. Overridden in tests by a script that replays a recording. */
  readonly executable?: string;
  readonly spawn?: AgentSpawn;
  /** Model alias, when the installation's default is not what this agent should use. */
  readonly model?: string | undefined;
  /** A run that never ends would wedge the app. Killed at this age. */
  readonly timeoutMs?: number;
}

export interface LibrarianRunRequest {
  readonly runId: string;
  /** What this pass is for. Short: the standing instructions are in the system prompt. */
  readonly task: string;
  /** Directories the run may read. The wiki, materialised. */
  readonly readRoots: readonly string[];
  readonly capabilities?: readonly LibrarianCapability[];
}

export interface LibrarianRunOutcome {
  readonly runId: string;
  /** Where the run wrote. Its files are proposals until somebody accepts them. */
  readonly directory: string;
  readonly exitCode: number | null;
  readonly ok: boolean;
  /** The `result` event's text, when the run got that far. */
  readonly summary: string;
  readonly turns: number;
  readonly costUsd: number | null;
  readonly events: readonly AgentEvent[];
  readonly cancelled: boolean;
  /** The exact argv, so a test can assert the spawn rather than trust it. */
  readonly argv: readonly string[];
}

export class LibrarianRunner {
  readonly #workspace: AgentWorkspace;
  readonly #logger: Logger;
  readonly #executable: string;
  readonly #spawn: AgentSpawn;
  readonly #model: string | undefined;
  readonly #timeoutMs: number;
  readonly #active = new Map<string, SpawnedAgent>();
  /** Runs killed on purpose, so a SIGTERM exit is not reported as a crash. */
  readonly #cancelled = new Set<string>();

  constructor(options: LibrarianRunnerOptions) {
    this.#workspace = options.workspace;
    this.#logger = options.logger.child('librarian');
    this.#executable = options.executable ?? 'claude';
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#model = options.model;
    this.#timeoutMs = options.timeoutMs ?? 15 * 60_000;
  }

  /** Whether a run is in flight. The scheduler will not start a second one. */
  get busy(): boolean {
    return this.#active.size > 0;
  }

  async run(
    request: LibrarianRunRequest,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<LibrarianRunOutcome> {
    const capabilities = request.capabilities ?? DEFAULT_CAPABILITIES;
    const directory = await this.#workspace.runDirectory(request.runId);

    // The prompt is written through the workspace, not with `writeFile`. The runner has no
    // privileged path of its own — if it did, the boundary would have an exception in it.
    const promptPath = await this.#workspace.writeOrThrow(
      join('.runs', request.runId, 'system-prompt.md'),
      buildLibrarianPrompt(capabilities),
    );

    const argv = [
      '--print',
      '--system-prompt-file',
      promptPath,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--tools',
      CRAWL_TOOLS.join(','),
      // No `--mcp-config` accompanies this, so it means: no MCP servers at all.
      '--strict-mcp-config',
      ...(this.#model === undefined ? [] : ['--model', this.#model]),
      ...request.readRoots.flatMap((root) => ['--add-dir', root]),
      // Last, and always last: everything before it is a flag, and the task is the operand.
      request.task,
    ];

    this.#logger.info('librarian run starting', {
      runId: request.runId,
      capabilities: [...capabilities],
      readRoots: request.readRoots.length,
    });

    const child = this.#spawn(this.#executable, argv, { cwd: directory, env: process.env });
    this.#active.set(request.runId, child);

    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent): void => {
      events.push(event);
      onEvent?.(event);
    };

    const stderr: string[] = [];
    let cancelled = false;

    const exitCode = await new Promise<number | null>((resolve) => {
      let settled = false;
      const settle = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code);
      };

      const timer = setTimeout(() => {
        this.#logger.error('librarian run timed out', {
          runId: request.runId,
          timeoutMs: this.#timeoutMs,
        });
        cancelled = true;
        child.kill('SIGTERM');
      }, this.#timeoutMs);
      // A pending timer must not be what keeps the app alive at shutdown.
      if (typeof timer.unref === 'function') timer.unref();

      const splitter = new LineSplitter();
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        for (const line of splitter.push(chunk)) {
          for (const event of parseStreamLine(line)) emit(event);
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        // Kept rather than discarded: when the CLI refuses to start, this is the only
        // account of why, and a run that fails silently is the hardest kind to diagnose.
        stderr.push(chunk);
      });

      child.on('error', (error: Error) => {
        this.#logger.error('librarian could not be spawned', { runId: request.runId, error });
        settle(null);
      });

      child.on('close', (code: number | null) => {
        for (const line of splitter.flush()) {
          for (const event of parseStreamLine(line)) emit(event);
        }
        settle(code);
      });
    });

    this.#active.delete(request.runId);
    if (this.#cancelled.delete(request.runId)) cancelled = true;

    const finished = events.find(
      (event): event is Extract<AgentEvent, { kind: 'finished' }> => event.kind === 'finished',
    );
    const ok = exitCode === 0 && finished?.ok === true && !cancelled;

    if (!ok) {
      this.#logger.warn('librarian run did not finish cleanly', {
        runId: request.runId,
        exitCode,
        cancelled,
        stderr: stderr.join('').slice(0, 2000),
      });
    } else {
      this.#logger.info('librarian run finished', {
        runId: request.runId,
        turns: finished?.turns ?? 0,
        costUsd: finished?.costUsd ?? null,
      });
    }

    return {
      runId: request.runId,
      directory,
      exitCode,
      ok,
      summary: finished?.summary ?? '',
      turns: finished?.turns ?? 0,
      costUsd: finished?.costUsd ?? null,
      events,
      cancelled,
      argv,
    };
  }

  /** Stop a run. Returns false when there was nothing to stop. */
  cancel(runId: string): boolean {
    const child = this.#active.get(runId);
    if (child === undefined) return false;
    this.#cancelled.add(runId);
    this.#logger.info('librarian run cancelled', { runId });
    return child.kill('SIGTERM');
  }

  /** Stop everything. Called when the app quits, so no agent outlives the window. */
  cancelAll(): void {
    for (const runId of [...this.#active.keys()]) this.cancel(runId);
  }
}

const defaultSpawn: AgentSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
