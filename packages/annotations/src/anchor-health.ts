import type { AnnotationAnchor, ResolvedLocation } from '@wr/shared-types';

export interface AnchorHealth {
  /** `ok` — found where it was; `moved` — relocated by quote; `broken` — not found. */
  readonly state: 'ok' | 'moved' | 'broken';
  readonly label: string;
  readonly detail: string;
}

/**
 * Describe what resolution found, in terms the user can act on.
 *
 * The three states are deliberately distinguishable. "Moved" is reassurance — the highlight
 * is still on the right words after the document changed underneath it. "Broken" is a
 * request for attention: the anchored text is no longer in the document, and only the user
 * knows whether that is a re-import to redo or a note to rewrite.
 */
export function describeAnchorHealth(
  anchor: AnnotationAnchor,
  resolved: ResolvedLocation | null,
): AnchorHealth {
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
