/**
 * The librarian's write boundary (criterion A02).
 *
 * The whole value of this file is in the refusals. An agent that has been told to stay inside
 * its workspace will mostly stay inside it, so a test that writes one well-behaved note and
 * finds it on disk passes identically against an implementation with no enforcement at all.
 * Every case below therefore *tries to escape*, by a different route, and asserts both that
 * nothing landed outside and that the attempt was logged.
 *
 * The symlink case is the one that catches a real implementation being half-done: the
 * requested path is inside the root as a string, passes any lexical check, and still lands
 * outside because `open()` follows links.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type Logger } from '../../apps/desktop/src/main/logger.js';
import {
  AgentWorkspace,
  WorkspaceBoundaryError,
} from '../../apps/desktop/src/main/agents/workspace.js';

interface LogRecord {
  readonly event: string;
  readonly level: string;
  readonly reason?: string;
  readonly requested?: string;
}

describe('the librarian write boundary', () => {
  let dir: string;
  let outside: string;
  let workspace: AgentWorkspace;
  let records: LogRecord[];
  let logger: Logger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wr-agent-ws-'));
    outside = join(dir, 'not-the-workspace');
    mkdirSync(outside, { recursive: true });
    records = [];
    logger = createLogger({
      level: 'debug',
      sink: (line) => records.push(JSON.parse(line) as LogRecord),
    });
    workspace = new AgentWorkspace({ root: join(dir, 'librarian'), logger });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const refusals = (): LogRecord[] =>
    records.filter((record) => record.event.endsWith('agent write refused'));

  it('[A02] refuses a relative path that climbs out of the workspace, and logs it', async () => {
    const escape = join('..', 'not-the-workspace', 'stolen.md');

    const result = await workspace.write(escape, 'written by the agent');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('escapes-workspace');
    expect(existsSync(join(outside, 'stolen.md'))).toBe(false);

    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]?.level).toBe('warn');
    expect(refusals()[0]?.requested).toBe(escape);
  });

  it('[A02] refuses an absolute path outside the workspace, and logs it', async () => {
    const target = join(outside, 'absolute.md');

    const result = await workspace.write(target, 'written by the agent');

    expect(result.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]?.reason).toBe('escapes-workspace');
  });

  it('[A02] refuses a write that would follow a symlink out of the workspace', async () => {
    // The link is planted inside the workspace, so `notes/escape.md` is a string that lives
    // under the root. Only resolving it says otherwise.
    const root = await workspace.ensure();
    symlinkSync(outside, join(root, 'notes'));

    const result = await workspace.write(join('notes', 'escape.md'), 'written by the agent');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('escapes-workspace');
    expect(existsSync(join(outside, 'escape.md'))).toBe(false);
    expect(refusals()).toHaveLength(1);
  });

  it('[A02] refuses to overwrite an existing file that is a symlink pointing out', async () => {
    const root = await workspace.ensure();
    const victim = join(outside, 'existing.md');
    writeFileSync(victim, 'the researcher wrote this', 'utf8');
    symlinkSync(victim, join(root, 'looks-local.md'));

    const result = await workspace.write('looks-local.md', 'replaced by the agent');

    expect(result.ok).toBe(false);
    await expect(readFile(victim, 'utf8')).resolves.toBe('the researcher wrote this');
    expect(refusals()).toHaveLength(1);
  });

  it('[A02] refuses a path carrying a NUL byte, which truncates inside libc', async () => {
    const result = await workspace.write('notes/ok.md\0/../../escape.md', 'written by the agent');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
    expect(refusals()).toHaveLength(1);
  });

  it('[A02] throws at the call sites that cannot branch, rather than writing anyway', async () => {
    await expect(
      workspace.writeOrThrow(join('..', 'escape.md'), 'written by the agent'),
    ).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    expect(existsSync(join(dir, 'escape.md'))).toBe(false);
  });

  it('[A02] allows a write inside the workspace, including into a new subdirectory', async () => {
    const result = await workspace.write(join('notes', 'maps', 'attention.md'), '# Attention');

    expect(result.ok).toBe(true);
    if (result.ok) {
      await expect(readFile(result.path, 'utf8')).resolves.toBe('# Attention');
      expect(result.relative).toBe(join('notes', 'maps', 'attention.md'));
    }
    expect(refusals()).toHaveLength(0);
    await expect(workspace.list()).resolves.toEqual([join('notes', 'maps', 'attention.md')]);
  });

  it('[A02] keeps run staging inside the workspace and out of the workspace body', async () => {
    const root = await workspace.ensure();
    const staging = await workspace.runDirectory('run-1');

    expect(staging.startsWith(root)).toBe(true);
    await workspace.write(join('.runs', 'run-1', 'proposal.md'), 'proposed, not accepted');

    // A proposal is not a note: it is in the workspace, but not in what the workspace holds.
    await expect(workspace.list()).resolves.toEqual([]);
  });

  it('[A02] refuses a run id that tries to climb out through the staging path', async () => {
    await expect(workspace.runDirectory(join('..', '..', 'escape'))).rejects.toBeInstanceOf(
      WorkspaceBoundaryError,
    );
    expect(existsSync(join(dir, 'escape'))).toBe(false);
  });
});
