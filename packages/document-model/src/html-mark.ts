/**
 * Painting a highlight onto the saved page itself (`H10`).
 *
 * Every other reader draws its own marks: it owns the DOM the words are in. The archived-page
 * reader owns nothing of the sort. The page is framed with `sandbox` and no tokens, so it has
 * no script, an opaque origin and no way to be reached from the application's document — that
 * is the whole defence against markup taken off the open web, and it is not up for
 * negotiation. Until now the consequence was that a highlight made on a saved page was listed
 * *beside* the page rather than shown on it, which is the one place a highlight is worth
 * having.
 *
 * So the mark is put into the bytes before they are served. The archive on disk is never
 * touched; `rrfile://` already resolves the file and already reads its text to anchor against,
 * and this inserts `<mark>` elements into the copy it hands the frame. The frame gains no
 * script, no origin and no capability: what changes is that some of its characters arrive
 * wrapped in an element the CSP already allows to be styled.
 *
 * Two rules make that safe to do at all:
 *
 *   1. **Nothing is placed by guesswork.** The offsets come from `resolveHtmlAnchor`, and the
 *      only way back from them to the source is `TextWithSource` — the same scanner that
 *      produced the text the anchor was resolved against, carrying where each character came
 *      from. When the map cannot be trusted the page is served exactly as it is: an unmarked
 *      page is a small disappointment, a mark on the wrong sentence is a lie about what the
 *      researcher read.
 *   2. **A mark never crosses a tag.** Insertions are cut at the boundaries of the source's own
 *      character data, so a highlight spanning `<b>` or a paragraph break becomes several
 *      `<mark>` elements rather than one that would nest wrongly and let the browser repair it
 *      by highlighting something else entirely.
 */
import type { HighlightColor } from '@wr/shared-types';
import { extractHtmlTextWithSource, normalizeText, normalizeTextWithSource } from './normalize.js';

/** One highlight to paint, in the coordinate system anchors live in. */
export interface SnapshotHighlight {
  /** The annotation's id. Becomes `data-wr-annotation`, and the element id of its first run. */
  readonly id: string;
  readonly color: HighlightColor;
  /** Offsets into `normalizeText(extractHtmlText(html))`, half-open. */
  readonly start: number;
  readonly end: number;
}

/** The class every painted run carries. Styled by the block this module injects. */
export const SNAPSHOT_MARK_CLASS = 'wr-snapshot-mark';

/**
 * The element id the first run of a highlight carries, so the frame can be pointed at it with
 * an ordinary fragment. That is the only way to scroll a sandboxed archive to a sentence —
 * there is no script inside it to ask, and its document is not reachable from outside.
 */
export function snapshotMarkElementId(annotationId: string): string {
  return `wr-mark-${annotationId}`;
}

/**
 * The palette, in hex.
 *
 * `@wr/shared-ui` states these as CSS custom properties and everything in the application
 * reads them from there. The archive cannot: it is a separate document with an opaque origin
 * and its own stylesheets, and a `var(--wr-highlight-tan)` inside it resolves to nothing at
 * all. So the six values are restated here, for the one document that cannot see them, and
 * `highlight-colors.ts` remains the authority for every surface that can.
 */
const MARK_BACKGROUNDS: Readonly<Record<HighlightColor, string>> = {
  default: '#f3e3a8',
  tan: '#e3cfa6',
  spruce: '#b3d8c0',
  ochre: '#f0c489',
  clay: '#eebaa8',
  signal: '#f2a0bd',
};

/**
 * An id is written into markup, so it is checked rather than trusted.
 *
 * These come from the application's own database and are minted ids, so this can never fire in
 * practice — which is exactly why it is here and not a comment. A highlight whose id would
 * need escaping is not painted at all.
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** A contiguous stretch of the source to wrap, and the highlight it belongs to. */
interface MarkRun {
  readonly start: number;
  readonly end: number;
  readonly highlight: SnapshotHighlight;
  /** True for the first run of its highlight: the one that carries the element id. */
  readonly leads: boolean;
}

/**
 * Insert the highlights into the archive's markup and return the marked copy.
 *
 * Answers `html` unchanged when there is nothing to paint or when the map cannot be shown to
 * describe the very text the offsets are into.
 */
export function markSnapshotHtml(
  html: string,
  highlights: readonly SnapshotHighlight[],
): string {
  if (highlights.length === 0) return html;

  const extracted = extractHtmlTextWithSource(html);
  const mapped = normalizeTextWithSource(extracted);
  // The map has to describe the same string the anchors were resolved against, or the offsets
  // mean something else. Compared against `normalizeText` itself rather than assumed: this is
  // the one check that catches a mapped step drifting from the plain one, and its answer when
  // it fires is to paint nothing.
  if (mapped.text !== normalizeText(extracted.text)) return html;
  if (mapped.starts.length !== mapped.text.length) return html;

  const runs = planRuns(html, mapped, highlights);
  if (runs.length === 0) return html;

  let out = '';
  let copied = 0;
  for (const run of runs) {
    out += html.slice(copied, run.start);
    out += openingTag(run);
    out += html.slice(run.start, run.end);
    out += '</mark>';
    copied = run.end;
  }
  out += html.slice(copied);
  return withMarkStyle(out);
}

function openingTag(run: MarkRun): string {
  const id = run.leads ? ` id="${snapshotMarkElementId(run.highlight.id)}"` : '';
  return (
    `<mark class="${SNAPSHOT_MARK_CLASS}"${id}` +
    ` data-wr-annotation="${run.highlight.id}" data-wr-color="${run.highlight.color}">`
  );
}

/**
 * Turn text offsets into the stretches of source that may be wrapped.
 *
 * Two things happen here and both are refusals. A character with an empty source range — the
 * newline a `<p>` stands for — is dropped, because there is nothing in the file to wrap. And
 * two stretches are joined only when what lies between them holds no angle bracket, so a run
 * never grows across a tag: that is what keeps every `<mark>` inside one text node's worth of
 * markup, and therefore keeps the browser from repairing an improperly nested one by painting
 * a different part of the page.
 */
function planRuns(
  html: string,
  mapped: { readonly text: string; readonly starts: readonly number[]; readonly ends: readonly number[] },
  highlights: readonly SnapshotHighlight[],
): MarkRun[] {
  const planned: MarkRun[] = [];

  for (const highlight of highlights) {
    if (!SAFE_ID.test(highlight.id)) continue;
    const from = Math.max(0, Math.min(highlight.start, mapped.text.length));
    const to = Math.max(from, Math.min(highlight.end, mapped.text.length));
    if (from >= to) continue;

    const spans: Array<{ start: number; end: number }> = [];
    for (let i = from; i < to; i += 1) {
      const start = mapped.starts[i] ?? 0;
      const end = mapped.ends[i] ?? 0;
      if (end <= start) continue;
      const last = spans[spans.length - 1];
      if (last !== undefined && start >= last.end && !crossesMarkup(html, last.end, start)) {
        last.end = end;
      } else {
        spans.push({ start, end });
      }
    }
    for (const [index, span] of spans.entries()) {
      planned.push({ start: span.start, end: span.end, highlight, leads: index === 0 });
    }
  }

  // Overlaps are clipped rather than nested: two highlights over the same sentence are two
  // rows in the database, but they are one stretch of a page, and `<mark><mark></mark></mark>`
  // written across a text node is not something a parser is obliged to keep.
  planned.sort((a, b) => a.start - b.start || a.end - b.end);
  const runs: MarkRun[] = [];
  let cursor = 0;
  for (const run of planned) {
    const start = Math.max(run.start, cursor);
    if (start >= run.end) continue;
    runs.push({ ...run, start, leads: run.leads && start === run.start });
    cursor = run.end;
  }
  return runs;
}

/** Whether the gap between two mapped characters contains markup rather than plain text. */
function crossesMarkup(html: string, from: number, to: number): boolean {
  const between = html.slice(from, to);
  return between.includes('<') || between.includes('>');
}

/**
 * The stylesheet, inlined into the page.
 *
 * `style-src rrfile: 'unsafe-inline'` is already in the policy served with an archive, and for
 * the reason `snapshotSecurityHeaders` gives: pages save their layout as `<style>` blocks, and
 * one served without them is not the page. So this needs no relaxation of anything. It is
 * `!important` because the page's own stylesheet may well have an opinion about `mark`, and
 * this one is the reader's rather than the site's.
 */
function markStyleBlock(): string {
  const rules = [
    `mark.${SNAPSHOT_MARK_CLASS}{background-color:${MARK_BACKGROUNDS.default} !important;` +
      'color:inherit !important;padding:0 !important;border-radius:0.15em;' +
      'box-decoration-break:clone;-webkit-box-decoration-break:clone;}',
    ...Object.entries(MARK_BACKGROUNDS)
      .filter(([color]) => color !== 'default')
      .map(
        ([color, background]) =>
          `mark.${SNAPSHOT_MARK_CLASS}[data-wr-color="${color}"]` +
          `{background-color:${background} !important;}`,
      ),
  ];
  return `<style data-wr-snapshot-marks>${rules.join('')}</style>`;
}

/**
 * Put the style where the document will keep it.
 *
 * After `<head>` when there is one, after `<body>` when there is not, and at the end when the
 * archive is a bare fragment — never before a `<!doctype>`, which would put the page into
 * quirks mode and change how the whole thing is laid out.
 */
function withMarkStyle(html: string): string {
  const style = markStyleBlock();
  for (const opening of [/<head\b[^>]*>/i, /<body\b[^>]*>/i]) {
    const match = opening.exec(html);
    if (match !== null) {
      const at = match.index + match[0].length;
      return html.slice(0, at) + style + html.slice(at);
    }
  }
  return html + style;
}
