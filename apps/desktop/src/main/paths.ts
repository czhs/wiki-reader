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
import { basename, isAbsolute, normalize, relative, resolve, sep } from 'node:path';

export interface AllowedRoots {
  readonly roots: readonly string[];
  /**
   * Single files the researcher handed over one at a time — dropped on a board, or picked in
   * the file dialog.
   *
   * A file admitted this way widens what the app may read by exactly one path. The obvious
   * alternative — admitting the folder it came from — would turn "I want this paper" into "you
   * may read my whole Downloads directory", and the row-level guarantee in `resolveFileRequest`
   * would stop meaning anything for anyone who ever dropped a file.
   *
   * Optional so that every existing construction of an allow-list keeps meaning what it did.
   */
  readonly files?: readonly string[];
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

/**
 * An absolute path as it appears inside a line of text.
 *
 * The lookbehind is what keeps `and/or` from being read as the path `/or`: a path starts at
 * the beginning of the line or after whitespace or an opening delimiter, never mid-word.
 */
const ABSOLUTE_IN_TEXT = /(?<![^\s`'"([{,;])\/[^\s`'")\]}]*/g;

/** Trailing sentence punctuation is not part of the path it follows. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function relativiseAbsolute(candidate: string, roots: readonly string[]): string {
  for (const root of roots) {
    if (!isInsideRoot(candidate, root)) continue;
    const inside = relative(resolve(root), resolve(candidate));
    return inside.length === 0 ? '.' : inside;
  }
  return basename(candidate);
}

/**
 * Rewrite every absolute path in a line of text so the line can cross to the renderer.
 *
 * The librarian's transcript is made of absolute paths: Claude Code's `Read` takes one, and
 * the model narrates its own working directory in prose. Dropping the line loses the only
 * thing that makes a running pass watchable, so instead each path is reduced to a form that
 * says *what* without saying *where* — relative to whichever root the run was given if it
 * lies inside one, and otherwise its basename alone. Neither form tells the renderer where
 * on disk anything is, which is the invariant in `CLAUDE.md` and `docs/SECURITY.md`.
 */
export function withoutFilesystemPaths(text: string, roots: readonly string[]): string {
  return text.replace(ABSOLUTE_IN_TEXT, (match) => {
    const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    const candidate = trailing.length === 0 ? match : match.slice(0, -trailing.length);
    // A lone `/` names no file, so there is nothing in it to disclose.
    if (candidate === '/' || candidate.length === 0) return match;
    return `${relativiseAbsolute(candidate, roots)}${trailing}`;
  });
}

export function isAllowedPath(candidate: string, allowed: AllowedRoots): boolean {
  if (!isAbsolute(candidate)) return false;
  // A NUL byte truncates the path inside libc, so what the OS opens is not what was checked.
  if (candidate.includes('\0')) return false;
  const normalized = normalize(candidate);
  return (
    allowed.roots.some((root) => isInsideRoot(normalized, root)) || isAdmittedFile(normalized, allowed)
  );
}

/**
 * Whether this exact file was admitted.
 *
 * Exact, not prefix: an admitted file is one file. `resolve` on both sides so `/a/./b.pdf`
 * and `/a/b.pdf` are the same admission, and nothing else is.
 */
export function isAdmittedFile(candidate: string, allowed: AllowedRoots): boolean {
  const target = resolve(candidate);
  return (allowed.files ?? []).some((file) => resolve(file) === target);
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
  // Containment is decided on the *real* path, and so is admission: a symlink dropped on the
  // board is admitted as what it resolves to, so the admission cannot be re-aimed afterwards
  // by rewriting the link.
  if (!allowed.roots.some((root) => isInsideRoot(real, root)) && !isAdmittedFile(real, allowed)) {
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
/**
 * An allow-list with one root that can be replaced while the app runs.
 *
 * The notes folder is chosen in the app, so it is not a constant of the installation the way
 * the Zotero data directory is. Everything that checks a path — the `rrfile://` handler, the
 * extraction pipeline, the corpus importer — is handed *this object* at construction and
 * reads `roots` at the moment of the check, so changing the folder takes effect everywhere
 * at once. Handing each of them a snapshot array instead would leave the old folder readable
 * by whichever component happened to be built first.
 *
 * Dropping the previous folder from the list is the point: after the switch, a document row
 * still pointing into it resolves to nothing and `rrfile://` refuses it. The purge that
 * follows removes those rows, so the refusal is never what the reader sees.
 */
export class SwappableRoots implements AllowedRoots {
  readonly #fixed: readonly (string | undefined | null)[];
  #swappable: string | null;
  #current: AllowedRoots;
  /** Files admitted one at a time. Insertion-ordered, so the remembered list is stable. */
  readonly #files = new Set<string>();

  constructor(
    fixed: readonly (string | undefined | null)[],
    swappable: string | null,
    admitted: readonly string[] = [],
  ) {
    this.#fixed = [...fixed];
    this.#swappable = swappable;
    this.#current = allowedRoots(...this.#fixed, swappable);
    for (const file of admitted) this.admit(file);
  }

  get roots(): readonly string[] {
    return this.#current.roots;
  }

  get files(): readonly string[] {
    return [...this.#files];
  }

  /**
   * Widen the allow-list by exactly one file.
   *
   * Only ever called with a path the *operating system* produced — a drop, or a file dialog —
   * never with one the renderer sent, because the renderer neither sends nor receives paths.
   * Returns false for anything that is not an absolute path, so a hand-edited settings row
   * cannot smuggle a relative one past the resolver.
   */
  admit(path: string): boolean {
    if (!isAbsolute(path) || path.includes('\0')) return false;
    this.#files.add(resolve(path));
    return true;
  }

  /** Stop reading a file that is no longer in the library. */
  withdraw(path: string): boolean {
    return this.#files.delete(resolve(path));
  }

  /** The root currently occupying the swappable slot. */
  get swappable(): string | null {
    return this.#swappable;
  }

  swap(next: string | null): void {
    this.#swappable = next;
    this.#current = allowedRoots(...this.#fixed, next);
  }
}

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
