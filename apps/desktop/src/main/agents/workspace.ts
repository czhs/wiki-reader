/**
 * The librarian's write boundary.
 *
 * The librarian reads the whole wiki and writes only in its own workspace. That is the one
 * rule the agent cannot be trusted to keep for itself: a saved web page is hostile input, and
 * a page that talks the agent into writing somewhere else has to fail *here*, at the tool
 * boundary, regardless of what the system prompt said. `A02` asserts the refusal, not the
 * happy path — an agent told to stay inside its folder will mostly comply, so a test that
 * only writes a well-behaved note passes against no enforcement at all.
 *
 * Every write made on the agent's behalf goes through this class. There is no other path:
 * accepting a proposal calls `write`, a run's staging directory is minted by `runDirectory`,
 * and both resolve against the same root.
 */
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isInsideRoot } from '../paths.js';
import type { Logger } from '../logger.js';

/**
 * Why a write was refused.
 *
 * `escapes-workspace` is the security case and is logged as one. `malformed` covers the
 * inputs that are not paths at all — empty, or carrying a NUL byte, which truncates the
 * string inside libc so that what the OS opens is not what was checked.
 */
export type WriteRefusalReason = 'escapes-workspace' | 'malformed';

export type WorkspaceWrite =
  | { readonly ok: true; readonly path: string; readonly relative: string }
  | { readonly ok: false; readonly reason: WriteRefusalReason };

export interface AgentWorkspaceOptions {
  /** Absolute path to the one directory this agent may write in. Created if absent. */
  readonly root: string;
  readonly logger: Logger;
}

/**
 * A refused write raised as an error, for the call sites that cannot carry on without one.
 */
export class WorkspaceBoundaryError extends Error {
  constructor(
    readonly requested: string,
    readonly reason: WriteRefusalReason,
  ) {
    super(`The agent may not write to ${requested}.`);
    this.name = 'WorkspaceBoundaryError';
  }
}

export class AgentWorkspace {
  readonly #logger: Logger;
  readonly #configuredRoot: string;
  /** The root after symlink resolution. Established on first use, then reused. */
  #realRoot: string | null = null;

  constructor(options: AgentWorkspaceOptions) {
    if (!isAbsolute(options.root)) {
      throw new Error('An agent workspace root must be an absolute path.');
    }
    this.#configuredRoot = resolve(options.root);
    this.#logger = options.logger.child('agent-workspace');
  }

  /** The configured root. Not a promise, so it can go in a log line or a spawn argument. */
  get root(): string {
    return this.#configuredRoot;
  }

  /**
   * Create the workspace if it is not there yet and return its real path.
   *
   * Resolution happens once and is cached: the root is ours, created by us, and re-running
   * `realpath` on every write would put a syscall in front of each one for no new safety.
   */
  async ensure(): Promise<string> {
    if (this.#realRoot !== null) return this.#realRoot;
    await mkdir(this.#configuredRoot, { recursive: true });
    const real = await realpath(this.#configuredRoot);
    this.#realRoot = real;
    return real;
  }

  /**
   * Decide whether a path may be written, without writing it.
   *
   * Three separate escapes have to fail, and only the first is obvious:
   *
   * 1. `../../elsewhere.md` — caught lexically, after resolving against the root.
   * 2. `/etc/passwd` — an absolute path is not a location *within* the workspace, so it is
   *    refused outright rather than being silently reinterpreted as a relative one.
   * 3. `notes/link.md`, where `notes` is a symlink out of the workspace — the string is
   *    inside the root and passes (1) and (2), but `open()` follows the link. Containment is
   *    therefore decided a second time on the real path of the deepest ancestor that exists,
   *    which is what the OS will actually walk.
   */
  async resolveWrite(requested: string): Promise<WorkspaceWrite> {
    const root = await this.ensure();

    if (requested.length === 0 || requested.includes('\0')) {
      this.#refuse(requested, 'malformed');
      return { ok: false, reason: 'malformed' };
    }
    if (isAbsolute(requested)) {
      this.#refuse(requested, 'escapes-workspace');
      return { ok: false, reason: 'escapes-workspace' };
    }

    const target = resolve(root, requested);
    if (!isInsideRoot(target, root)) {
      this.#refuse(requested, 'escapes-workspace');
      return { ok: false, reason: 'escapes-workspace' };
    }

    const real = await this.#realTarget(target, root);
    if (real === null || !isInsideRoot(real, root)) {
      this.#refuse(requested, 'escapes-workspace');
      return { ok: false, reason: 'escapes-workspace' };
    }

    return { ok: true, path: real, relative: relative(root, real) };
  }

  /** Write a file into the workspace. Anything that would land outside is refused. */
  async write(requested: string, contents: string): Promise<WorkspaceWrite> {
    const resolved = await this.resolveWrite(requested);
    if (!resolved.ok) return resolved;
    await mkdir(dirname(resolved.path), { recursive: true });
    await writeFile(resolved.path, contents, 'utf8');
    this.#logger.info('agent write', { path: resolved.relative, bytes: contents.length });
    return resolved;
  }

  /** As `write`, for the call sites that must fail loudly rather than branch. */
  async writeOrThrow(requested: string, contents: string): Promise<string> {
    const result = await this.write(requested, contents);
    if (!result.ok) throw new WorkspaceBoundaryError(requested, result.reason);
    return result.path;
  }

  /**
   * A run's staging directory, `.runs/<runId>`.
   *
   * A run writes here rather than into the workspace body, because nothing the librarian
   * produces lands without an accept. Keeping staging *inside* the workspace is what makes
   * "writes only in its own workspace" literally true of the spawned process, which is given
   * this directory and nothing else.
   */
  async runDirectory(runId: string): Promise<string> {
    const resolved = await this.resolveWrite(join('.runs', runId));
    if (!resolved.ok) throw new WorkspaceBoundaryError(runId, resolved.reason);
    await mkdir(resolved.path, { recursive: true });
    return resolved.path;
  }

  /** Read a file back out of the workspace. Bounded by the same rule as writing. */
  async read(requested: string): Promise<string | null> {
    const resolved = await this.resolveWrite(requested);
    if (!resolved.ok) return null;
    try {
      return await readFile(resolved.path, 'utf8');
    } catch {
      return null;
    }
  }

  /** Every file in the workspace body, workspace-relative, excluding run staging. */
  async list(): Promise<string[]> {
    const root = await this.ensure();
    const found: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        // Staging is not part of the workspace body: it holds what has been proposed, and a
        // proposal is not yet a note.
        if (entry.name === '.runs') continue;
        const child = join(directory, entry.name);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) found.push(relative(root, child));
      }
    };
    try {
      await walk(root);
    } catch {
      return [];
    }
    return found.sort();
  }

  #refuse(requested: string, reason: WriteRefusalReason): void {
    // Logged at `warn` because this is a boundary violation, not a missing file. It names
    // what was asked for, so a run that keeps trying to escape is visible in the log.
    this.#logger.warn('agent write refused', {
      requested,
      reason,
      workspace: this.#configuredRoot,
    });
  }

  /**
   * The real path a write would land on.
   *
   * The file itself usually does not exist yet, so `realpath` is applied to the deepest
   * ancestor that does and the remaining segments are re-appended. That resolves every
   * symlink the OS would follow on the way down without requiring the leaf to be there.
   */
  async #realTarget(target: string, root: string): Promise<string | null> {
    const trailing: string[] = [];
    let current = target;
    for (;;) {
      try {
        const real = await realpath(current);
        return trailing.length === 0 ? real : join(real, ...trailing.reverse());
      } catch {
        const parent = dirname(current);
        // Ran out of path before finding anything that exists, or walked above the root:
        // either way there is nothing left to resolve against.
        if (parent === current) return null;
        if (!isInsideRoot(parent, root) && parent !== root) return null;
        trailing.push(current.slice(parent.length + sep.length));
        current = parent;
      }
    }
  }
}
