/**
 * Shortening text for display.
 *
 * Deliberately *not* `normalizeText`. That one is versioned and every persisted character
 * offset depends on it; these two are for labels, tooltips, status lines and snippets, and
 * nothing is ever stored or anchored from what they return. Keeping them apart is what stops
 * a change to how a title reads on a disc from moving every anchor in the library.
 *
 * They were seven copies of the same two lines — two in `@wr/database`, one in `excerpt.ts`
 * a few lines from here, four in the renderer — differing only in whether the ellipsis was
 * inside the budget. One spelling, one contract: `limit` is the width of the answer, ellipsis
 * included, so a caller that has room for forty characters asks for forty.
 */

/**
 * Whitespace collapsed to single spaces and trimmed.
 *
 * A marked sentence that ran over three lines of a PDF arrives with the line breaks in it,
 * and a label is one line. Every place that cuts text to a budget wants this first, because a
 * newline inside a budget spends a character on something that draws as nothing.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * At most `limit` characters, the last an ellipsis when something had to be dropped.
 *
 * The ellipsis is inside the budget rather than added to it: a caller says how much room it
 * has, and what comes back fits. A `limit` below 1 is not a case any caller has — the answer
 * degrades to the ellipsis alone rather than throwing, because a label is not worth a crash.
 */
export function ellipsize(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * One line of a passage, cut to a budget: the two above, in the order they are always used in.
 *
 * Every caller that shows a fragment of somebody's prose wants both — a marked sentence that
 * ran over three lines of a PDF arrives with the line breaks in it, and a budget spent on a
 * newline is a budget spent on nothing. `EntityResolver`, the graph repository and the excerpt
 * picker each wrote the composition out with a comment pointing at the other two.
 */
export function shorten(text: string, limit: number): string {
  return ellipsize(collapseWhitespace(text), limit);
}
