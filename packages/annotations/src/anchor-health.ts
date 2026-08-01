import type { AnnotationAnchor, ResolvedLocation } from '@wr/shared-types';

export interface AnchorHealth {
  /**
   * `ok` — found where it was; `moved` — relocated by quote; `broken` — not found;
   * `unknown` — nothing has tried to resolve it yet.
   */
  readonly state: 'ok' | 'moved' | 'broken' | 'unknown';
  readonly label: string;
  readonly detail: string;
}

/**
 * Describe what resolution found, in terms the user can act on.
 *
 * The four states are deliberately distinguishable. "Moved" is reassurance — the highlight
 * is still on the right words after the document changed underneath it. "Broken" is a
 * request for attention: the anchored text is no longer in the document, and only the user
 * knows whether that is a re-import to redo or a note to rewrite.
 *
 * "Unknown" is the one that is not a claim at all. Only a reader can resolve an anchor, and
 * not every reader reports back — so `undefined` means *nobody has looked*, and it must not
 * be shown as a failure. Saying "Anchor broken" over a highlight the researcher can see on
 * the page in front of them teaches them to disbelieve the badge, which costs the warning
 * everything it is for.
 */
export function describeAnchorHealth(
  anchor: AnnotationAnchor,
  resolved: ResolvedLocation | null | undefined,
): AnchorHealth {
  if (resolved === undefined) {
    return {
      state: 'unknown',
      label: 'Not checked',
      detail: 'Nothing has resolved this anchor against the document yet.',
    };
  }

  if (resolved === null) {
    return {
      state: 'broken',
      label: 'Anchor broken',
      detail:
        'The highlighted text is no longer in this document. The annotation and its notes ' +
        'are intact, but there is nothing left to point at.',
    };
  }

  if (resolved.strategy === 'exact-position') {
    return { state: 'ok', label: 'Anchored', detail: 'Found exactly where it was made.' };
  }

  const page = anchor.kind === 'pdf' ? ` on page ${String(anchor.pageIndex + 1)}` : '';
  return {
    state: 'moved',
    label: 'Relocated',
    detail:
      `The document changed, so this highlight was relocated${page} by matching its text ` +
      `(${resolved.strategy}, confidence ${resolved.confidence.toFixed(2)}).`,
  };
}
