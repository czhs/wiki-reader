/**
 * Filesystem roots the application is willing to read from.
 *
 * The renderer never sends or receives a path — it addresses bytes by file ID through
 * `rrfile://`. This module is the second half of that guarantee: even when a *database row*
 * points somewhere unexpected (a hand-edited row, a restored backup, a Zotero linked-file
 * base directory that has since changed), resolution refuses anything outside an allowed
 * root. A compromised or buggy row must not become an arbitrary-file-read.
 */
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

/** Build the allow-list. Empty and relative entries are dropped rather than trusted. */
export function allowedRoots(...roots: readonly (string | undefined | null)[]): AllowedRoots {
  const cleaned = roots
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
    .filter((root) => isAbsolute(root))
    .map((root) => resolve(root));
  return { roots: [...new Set(cleaned)] };
}
