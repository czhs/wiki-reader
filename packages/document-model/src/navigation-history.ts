import type { NavigationLocation } from '@wr/shared-types';

/**
 * Editor-style navigation history, independent of browser history.
 *
 * Semantics match VS Code's Go Back / Go Forward:
 * - `push` truncates the forward stack, as any editor does after you navigate somewhere new.
 * - Consecutive pushes to a location "equivalent" to the current one collapse, so scrolling
 *   inside one page does not flood the stack.
 * - `back` and `forward` move a cursor; they do not mutate the entries, so a round trip
 *   returns you exactly where you were.
 */

export const DEFAULT_HISTORY_LIMIT = 100;

/**
 * Two locations collapse when they address the same thing at roughly the same place.
 * Different pages of the same PDF are distinct; two scroll offsets on one page are not.
 */
export function isEquivalentLocation(a: NavigationLocation, b: NavigationLocation): boolean {
  if (a.entityId !== b.entityId || a.entityType !== b.entityType) return false;
  if (a.documentId !== b.documentId) return false;

  const locA = a.location;
  const locB = b.location;
  if (locA === undefined || locB === undefined) return locA === locB;
  if (locA.kind !== locB.kind) return false;

  switch (locA.kind) {
    case 'pdf':
      return locB.kind === 'pdf' && locA.pageIndex === locB.pageIndex;
    case 'html':
      return locB.kind === 'html' && locA.sectionPath === locB.sectionPath;
    case 'note':
      return locB.kind === 'note' && locA.blockIndex === locB.blockIndex;
    default: {
      const exhaustive: never = locA;
      return exhaustive;
    }
  }
}

export class NavigationHistory {
  readonly #entries: NavigationLocation[] = [];
  #cursor = -1;
  readonly #limit: number;

  constructor(limit: number = DEFAULT_HISTORY_LIMIT) {
    if (limit < 1) throw new RangeError('history limit must be at least 1');
    this.#limit = limit;
  }

  get size(): number {
    return this.#entries.length;
  }

  get cursor(): number {
    return this.#cursor;
  }

  get current(): NavigationLocation | null {
    return this.#entries[this.#cursor] ?? null;
  }

  get canGoBack(): boolean {
    return this.#cursor > 0;
  }

  get canGoForward(): boolean {
    return this.#cursor >= 0 && this.#cursor < this.#entries.length - 1;
  }

  /** Snapshot of the entries, oldest first. */
  entries(): readonly NavigationLocation[] {
    return [...this.#entries];
  }

  /**
   * Record a new location. Truncates anything ahead of the cursor. Returns `false` when the
   * push collapsed into the current entry instead of creating one.
   */
  push(location: NavigationLocation): boolean {
    const current = this.current;
    if (current !== null && isEquivalentLocation(current, location)) {
      // Keep the most precise version of the same place.
      this.#entries[this.#cursor] = location;
      return false;
    }

    if (this.#cursor < this.#entries.length - 1) {
      this.#entries.length = this.#cursor + 1;
    }
    this.#entries.push(location);

    if (this.#entries.length > this.#limit) {
      const overflow = this.#entries.length - this.#limit;
      this.#entries.splice(0, overflow);
    }
    this.#cursor = this.#entries.length - 1;
    return true;
  }

  /** Step back one entry. Returns the location now current, or `null` at the start. */
  back(): NavigationLocation | null {
    if (!this.canGoBack) return null;
    this.#cursor -= 1;
    return this.#entries[this.#cursor] ?? null;
  }

  /** Step forward one entry. Returns the location now current, or `null` at the end. */
  forward(): NavigationLocation | null {
    if (!this.canGoForward) return null;
    this.#cursor += 1;
    return this.#entries[this.#cursor] ?? null;
  }

  clear(): void {
    this.#entries.length = 0;
    this.#cursor = -1;
  }

  /** Serializable form, for persisting history alongside the workspace layout. */
  toJSON(): { entries: NavigationLocation[]; cursor: number } {
    return { entries: [...this.#entries], cursor: this.#cursor };
  }

  /**
   * Adopt a persisted history in place.
   *
   * The workbench holds one history instance for its lifetime, so restoring a saved
   * workspace refills that instance rather than swapping it — a replaced object would
   * leave the already-registered `goBack`/`goForward` commands pointing at the old one.
   * Entries beyond the limit are dropped from the front, keeping the most recent.
   */
  restore(data: { entries: readonly NavigationLocation[]; cursor: number }): void {
    const kept = data.entries.slice(-this.#limit);
    const dropped = data.entries.length - kept.length;
    this.#entries.length = 0;
    this.#entries.push(...kept);
    const maxCursor = this.#entries.length - 1;
    this.#cursor = Math.max(-1, Math.min(data.cursor - dropped, maxCursor));
  }

  static fromJSON(
    data: { entries: NavigationLocation[]; cursor: number },
    limit: number = DEFAULT_HISTORY_LIMIT,
  ): NavigationHistory {
    const history = new NavigationHistory(limit);
    for (const entry of data.entries) {
      history.#entries.push(entry);
    }
    const maxCursor = history.#entries.length - 1;
    history.#cursor = Math.max(-1, Math.min(data.cursor, maxCursor));
    return history;
  }
}
