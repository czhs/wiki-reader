/**
 * Security invariants that the rest of the suite assumes but never proves.
 *
 * These cover the two halves of "file bytes reach the renderer only through `rrfile://`,
 * which refuses paths outside the allowed roots": the path check itself, and the request
 * filter that stops a renderer reaching the network. Both are invariants in CLAUDE.md, and
 * before this file neither had a single test — `isAllowedPath` had no test anywhere.
 *
 * Every case here failed before the fix it accompanies.
 */
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedRoots, isAllowedPath, resolveAllowedPath } from '../../apps/desktop/src/main/paths.js';
import { isLoopbackUrl } from '../../apps/desktop/src/main/protocol.js';

let dir: string;
let insideRoot: string;
let outside: string;

beforeEach(() => {
  // Resolved up front so the fixture paths are already real ones: on macOS `os.tmpdir()`
  // reports `/var/folders/…`, a symlink into `/private/var/folders/…`, and the point of these
  // tests is the symlinks they create deliberately, not the one the OS put in the temp path.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wr-security-')));
  insideRoot = join(dir, 'library');
  outside = join(dir, 'private');
  mkdirSync(insideRoot);
  mkdirSync(outside);
  writeFileSync(join(insideRoot, 'paper.pdf'), 'a legitimate document');
  writeFileSync(join(outside, 'secrets.txt'), 'not the library');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('allowed-root resolution', () => {
  it('accepts a real file inside an allowed root', async () => {
    const allowed = allowedRoots(insideRoot);
    const resolved = await resolveAllowedPath(join(insideRoot, 'paper.pdf'), allowed);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.path.endsWith('paper.pdf')).toBe(true);
  });

  it('refuses a symlink inside an allowed root that points outside it', async () => {
    const link = join(insideRoot, 'innocent.pdf');
    symlinkSync(join(outside, 'secrets.txt'), link);
    const allowed = allowedRoots(insideRoot);

    // The lexical check is satisfied — which is exactly why it is not sufficient on its own.
    expect(isAllowedPath(link, allowed)).toBe(true);
    expect(await resolveAllowedPath(link, allowed)).toEqual({
      ok: false,
      reason: 'outside-roots',
    });
  });

  it('refuses a directory symlink used to escape, not just a file one', async () => {
    symlinkSync(outside, join(insideRoot, 'elsewhere'));
    const allowed = allowedRoots(insideRoot);
    const resolved = await resolveAllowedPath(join(insideRoot, 'elsewhere', 'secrets.txt'), allowed);
    expect(resolved).toEqual({ ok: false, reason: 'outside-roots' });
  });

  it('still accepts a symlink that stays inside the allowed root', async () => {
    writeFileSync(join(insideRoot, 'real.pdf'), 'inside');
    symlinkSync(join(insideRoot, 'real.pdf'), join(insideRoot, 'alias.pdf'));
    const allowed = allowedRoots(insideRoot);
    const resolved = await resolveAllowedPath(join(insideRoot, 'alias.pdf'), allowed);
    expect(resolved.ok && resolved.path.endsWith('real.pdf')).toBe(true);
  });

  it('refuses traversal, relative paths, NUL truncation and dangling links', async () => {
    const allowed = allowedRoots(insideRoot);
    const escape = await resolveAllowedPath(join(insideRoot, '..', 'private', 'secrets.txt'), allowed);
    expect(escape).toEqual({ ok: false, reason: 'outside-roots' });
    expect(await resolveAllowedPath('library/paper.pdf', allowed)).toEqual({
      ok: false,
      reason: 'outside-roots',
    });
    expect(
      await resolveAllowedPath(`${join(insideRoot, 'paper.pdf')}\0.png`, allowed),
    ).toEqual({ ok: false, reason: 'outside-roots' });

    // A dangling link is refused as unreadable rather than as an escape: we cannot say where
    // it would have pointed, and a reader chasing a permissions problem would find none.
    symlinkSync(join(outside, 'gone.txt'), join(insideRoot, 'dangling.pdf'));
    const dangling = await resolveAllowedPath(join(insideRoot, 'dangling.pdf'), allowed);
    expect(dangling.ok).toBe(false);
    expect(dangling.ok === false && dangling.reason).toBe('unresolvable');
  });

  it('is not fooled by a sibling root whose name shares a prefix', async () => {
    const sibling = `${insideRoot}-secrets`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'x.pdf'), 'sibling');
    const allowed = allowedRoots(insideRoot);
    expect(await resolveAllowedPath(join(sibling, 'x.pdf'), allowed)).toEqual({
      ok: false,
      reason: 'outside-roots',
    });
  });
});

describe('renderer network lockdown', () => {
  it('blocks a remote host whose name merely begins with the loopback name', () => {
    // The bug this replaces: `url.startsWith('http://localhost')` returned true here, so a
    // renderer could load from an attacker-controlled host.
    expect(isLoopbackUrl('http://localhost.attacker.example/steal')).toBe(false);
    expect(isLoopbackUrl('http://localhost-evil.example/steal')).toBe(false);
    expect(isLoopbackUrl('http://127.0.0.1.attacker.example/steal')).toBe(false);
  });

  it('blocks ordinary remote origins over every intercepted scheme', () => {
    expect(isLoopbackUrl('https://example.com/tracker.js')).toBe(false);
    expect(isLoopbackUrl('http://example.com/tracker.js')).toBe(false);
    expect(isLoopbackUrl('wss://example.com/socket')).toBe(false);
    expect(isLoopbackUrl('not a url at all')).toBe(false);
  });

  it('allows the dev server and its HMR socket', () => {
    expect(isLoopbackUrl('http://localhost:5173/index.html')).toBe(true);
    expect(isLoopbackUrl('ws://localhost:5173/')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:5173/main.js')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:5173/main.js')).toBe(true);
  });

  it('does not treat a credentialed URL as loopback because of its userinfo', () => {
    // `http://localhost@evil.example/` has hostname `evil.example`.
    expect(isLoopbackUrl('http://localhost@evil.example/')).toBe(false);
  });
});
