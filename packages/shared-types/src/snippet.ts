/**
 * What `SearchResult.snippet` is made of, for the two ends that have to agree about it.
 *
 * FTS5 marks a match by wrapping it in two delimiters chosen by the caller. They are private-use
 * code points rather than `<mark>` or `**`, so text that happens to contain markup cannot forge a
 * highlight and the renderer can split on them without parsing anything. That only works while
 * both ends spell them the same way — the index writes them in the main process and the search
 * panel draws them in the renderer — so they live here, beside the schema of the field that
 * carries them, rather than in the main-only package that happens to produce it.
 *
 * A delimiter that reaches a screen is a bug: it has no glyph, so it draws as tofu. Anything
 * showing a snippet either draws the segments below or uses `plainSnippet`.
 */
export const SNIPPET_OPEN = '\u{E000}';
export const SNIPPET_CLOSE = '\u{E001}';

/** One run of a snippet, and whether the query is why it is there. */
export interface SnippetSegment {
  readonly text: string;
  readonly matched: boolean;
}

/**
 * Split a marked snippet into its plain and matched runs, in order.
 *
 * Tolerant by construction, because a snippet is text and not a syntax: an unpaired opener runs
 * to the end, an unpaired closer ends a run that never started, and either way every character
 * of the input comes out exactly once in exactly one segment. Empty runs are dropped so a caller
 * can map straight to elements.
 */
export function snippetSegments(snippet: string): readonly SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let matched = false;
  let start = 0;

  const push = (end: number): void => {
    const text = snippet.slice(start, end);
    if (text.length > 0) segments.push({ text, matched });
  };

  for (let index = 0; index < snippet.length; index += 1) {
    const character = snippet[index];
    if (character !== SNIPPET_OPEN && character !== SNIPPET_CLOSE) continue;
    push(index);
    matched = character === SNIPPET_OPEN;
    start = index + 1;
  }
  push(snippet.length);

  return segments;
}

/** The same text with every delimiter taken out — what a label or a title needs. */
export function stripSnippetMarkers(snippet: string): string {
  return snippet.split(SNIPPET_OPEN).join('').split(SNIPPET_CLOSE).join('');
}
