/**
 * Filesystem roots the application is willing to read from.
 *
 * The renderer never sends or receives a path — it addresses bytes by file ID through
 * `rrfile://`. This module is the second half of that guarantee: even when a *database row*
 * points somewhere unexpected (a hand-edited row, a restored backup, a Zotero linked-file
 * base directory that has since changed), resolution refuses anything outside an allowed
 * root. A compromised or buggy row must not become an arbitrary-file-read.
 */
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, sep } from 'node:path';

export interface AllowedRoots {
  readonly roots: readonly string[];
}

/**
 * Containment test that is not fooled by a prefix collision.
 *
 * `/Users/x/Zotero-secrets` starts with `/Users/x/Zotero` as a *string*, but is not inside
 * it as a *path*. The separator check is what makes those two cases different.
 */
export function isInsideRoot(candidate: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(
    normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep,
  );
}

export function isAllowedPath(candidate: string, allowed: AllowedRoots): boolean {
  if (!isAbsolute(candidate)) return false;
  // A NUL byte truncates the path inside libc, so what the OS opens is not what was checked.
  if (candidate.includes('\0')) return false;
  const normalized = normalize(candidate);
  return allowed.roots.some((root) => isInsideRoot(normalized, root));
}

/**
 * Why a path was refused. The two cases are not interchangeable: "outside the roots" is a
 * permission failure worth logging as one, while "unresolvable" is an ordinary missing file.
 * Collapsing them made a deleted PDF report as an attempted escape.
 */
export type PathResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: 'outside-roots' }
  | { readonly ok: false; readonly reason: 'unresolvable'; readonly cause: string };

/**
 * Resolve a candidate through symlinks and re-check containment.
 *
 * `isAllowedPath` compares strings. A symlink placed inside an allowed root — by a malicious
 * archive, a synced folder, or a user tidying their library — names a path that passes that
 * test while pointing anywhere on disk, and every caller goes on to `open()` it, which
 * follows the link. The check has to be made against what the OS will actually open, so this
 * returns the *real* path for the caller to use; opening anything else reopens the hole.
 *
 * Returns `null` when the path is outside the roots before or after resolution, or when it
 * cannot be resolved at all (a dangling link, or a file that is simply missing).
 */
export async function resolveAllowedPath(
  candidate: string,
  allowed: AllowedRoots,
): Promise<PathResolution> {
  // Deliberately not gated on `isAllowedPath`: that compares the *unresolved* string, and a
  // legitimate path can fail it while resolving inside a root — on macOS `/var/folders/…`
  // resolves into `/private/var/folders/…`. Containment is decided once, on the real path.
  //
  // A NUL byte truncates the path inside libc, so what the OS opens is not what was checked.
  if (!isAbsolute(candidate) || candidate.includes('\0')) {
    return { ok: false, reason: 'outside-roots' };
  }
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    return { ok: false, reason: 'unresolvable', cause: String(error) };
  }
  if (!allowed.roots.some((root) => isInsideRoot(real, root))) {
    return { ok: false, reason: 'outside-roots' };
  }
  return { ok: true, path: real };
}

/**
 * Build the allow-list. Empty and relative entries are dropped rather than trusted.
 *
 * Roots are resolved through symlinks too, because the candidates they are compared against
 * will be. On macOS `os.tmpdir()` reports `/var/folders/…`, which is itself a symlink into
 * `/private/var/folders/…`; leaving the root unresolved would reject every real path under it.
 */
export function allowedRoots(...roots: readonly (string | undefined | null)[]): AllowedRoots {
  const cleaned = roots
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
    .filter((root) => isAbsolute(root))
    .map((root) => {
      const absolute = resolve(root);
      try {
        return realpathSync(absolute);
      } catch {
        // A root that does not exist yet (a Zotero directory created on first import) stays
        // in the list lexically; candidates under it are still resolved before use.
        return absolute;
      }
    });
  return { roots: [...new Set(cleaned)] };
}
