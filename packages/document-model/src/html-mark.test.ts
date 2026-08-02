/**
 * Painting a highlight into an archived page's own markup.
 *
 * Two properties carry the whole of this, and every test below is one of them:
 *
 *   1. **What is wrapped is what was anchored.** The offsets are into a string with no tags,
 *      no entities and no collapsible whitespace in it, and the marks go into bytes that have
 *      all three. Every case here is a place where the two drift apart — an inline element in
 *      the middle of a sentence, a character reference, a line break the author typed at
 *      column 80 — and the assertion is always that the marked characters are the quoted ones.
 *   2. **Nothing else changes.** Strip the marks and the archive is byte-identical; read the
 *      text out of the marked page and it is the same text, which is what keeps the anchors of
 *      every *other* highlight on the page pointing where they did.
 */
import { describe, expect, it } from 'vitest';
import { markSnapshotHtml, snapshotMarkElementId, type SnapshotHighlight } from './html-mark.js';
import { extractHtmlText, normalizeText } from './normalize.js';

/** The offsets a highlight of `quote` would carry, found the way an anchor finds them. */
function rangeOf(html: string, quote: string): { start: number; end: number } {
  const text = normalizeText(extractHtmlText(html));
  const start = text.indexOf(quote);
  expect(start, `"${quote}" is not in the extracted text: "${text}"`).toBeGreaterThanOrEqual(0);
  return { start, end: start + quote.length };
}

function highlight(html: string, quote: string, over: Partial<SnapshotHighlight> = {}): SnapshotHighlight {
  return { id: 'ann_one', color: 'default', ...rangeOf(html, quote), ...over };
}

const MARK = /<mark\b[^>]*>([\s\S]*?)<\/mark>/g;

/** Every run the marking produced, as the text a reader would see inside it. */
function paintedRuns(marked: string): string[] {
  return [...marked.matchAll(MARK)].map((match) => match[1] ?? '');
}

/** What the page says once the marks are taken back off it. */
function unmarked(marked: string): string {
  return marked
    .replace(/<style data-wr-snapshot-marks>[\s\S]*?<\/style>/, '')
    .replace(/<mark\b[^>]*>/g, '')
    .replace(/<\/mark>/g, '');
}

describe('marking a snapshot', () => {
  it('wraps exactly the characters the offsets name', () => {
    const html = '<html><head><title>t</title></head><body><p>Read code, not papers.</p></body></html>';
    const marked = markSnapshotHtml(html, [highlight(html, 'code, not papers')]);

    expect(paintedRuns(marked)).toEqual(['code, not papers']);
    expect(unmarked(marked)).toBe(html);
  });

  it('leaves the page alone when there is nothing to paint', () => {
    const html = '<p>Nothing marked here.</p>';
    expect(markSnapshotHtml(html, [])).toBe(html);
  });

  it('cuts a run at every tag rather than wrapping across one', () => {
    const html = '<body><p>The field rewards <em>reading code</em> more than papers.</p></body>';
    const marked = markSnapshotHtml(html, [highlight(html, 'rewards reading code more')]);

    // Three runs, because the sentence crosses into and out of the `<em>`. One `<mark>` around
    // the lot would be `<mark>rewards <em>reading code</em> more</mark>`, which is fine, and
    // the same span across a *paragraph* boundary is not — so the rule is one rule.
    expect(paintedRuns(marked)).toEqual(['rewards ', 'reading code', ' more']);
    for (const run of paintedRuns(marked)) {
      expect(run).not.toContain('<');
    }
    expect(unmarked(marked)).toBe(html);
  });

  it('wraps a character reference whole rather than cutting into it', () => {
    const html = '<body><p>A caf&#233; society &mdash; of sorts.</p></body>';
    const marked = markSnapshotHtml(html, [highlight(html, 'café society - of')]);

    // The dash is one character in the extracted text, five in the file, and the mark covers
    // the five. Cutting at the third would leave `&md` in the page and lose the character.
    expect(paintedRuns(marked)).toEqual(['caf&#233; society &mdash; of']);
    expect(unmarked(marked)).toBe(html);
  });

  it('spans a line break the author typed, because the reader never saw one', () => {
    const html = '<body><p>one two\n   three four</p></body>';
    const marked = markSnapshotHtml(html, [highlight(html, 'two three')]);

    // The extracted text collapsed that whitespace to a single space; the source still has the
    // newline and the indentation, and the mark has to cover all of it.
    expect(paintedRuns(marked)).toEqual(['two\n   three']);
    expect(unmarked(marked)).toBe(html);
  });

  it('paints two highlights, each in its own colour, and names the first run of each', () => {
    const html = '<body><p>Alpha beta gamma delta.</p></body>';
    const marked = markSnapshotHtml(html, [
      highlight(html, 'Alpha', { id: 'ann_alpha', color: 'spruce' }),
      highlight(html, 'gamma delta', { id: 'ann_gamma', color: 'clay' }),
    ]);

    expect(paintedRuns(marked)).toEqual(['Alpha', 'gamma delta']);
    expect(marked).toContain(`id="${snapshotMarkElementId('ann_alpha')}"`);
    expect(marked).toContain('data-wr-color="spruce"');
    expect(marked).toContain(`id="${snapshotMarkElementId('ann_gamma')}"`);
    expect(marked).toContain('data-wr-color="clay"');
    // The style block is inline CSS, which the policy served with an archive already allows,
    // and it names every colour the palette has.
    expect(marked).toContain('<style data-wr-snapshot-marks>');
    expect(marked).not.toContain('<script');
  });

  it('gives a highlight split across tags one element id, not one per run', () => {
    const html = '<body><p>The field <em>rewards</em> reading.</p></body>';
    const marked = markSnapshotHtml(html, [highlight(html, 'field rewards reading')]);

    const ids = [...marked.matchAll(/<mark\b[^>]*?\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(paintedRuns(marked)).toHaveLength(3);
    expect(ids).toEqual([snapshotMarkElementId('ann_one')]);
  });

  it('clips one highlight against another instead of nesting them', () => {
    const html = '<body><p>Alpha beta gamma.</p></body>';
    const marked = markSnapshotHtml(html, [
      highlight(html, 'Alpha beta', { id: 'ann_first' }),
      highlight(html, 'beta gamma', { id: 'ann_second' }),
    ]);

    expect(paintedRuns(marked)).toEqual(['Alpha beta', ' gamma']);
    expect(unmarked(marked)).toBe(html);
  });

  it('paints nothing at all rather than something wrong, when asked to', () => {
    const html = '<body><p>Alpha beta gamma.</p></body>';

    // Past the end of the text, empty, backwards, and an id that would need escaping.
    const nonsense: SnapshotHighlight[] = [
      { id: 'ann_far', color: 'default', start: 9_000, end: 9_100 },
      { id: 'ann_empty', color: 'default', start: 3, end: 3 },
      { id: 'ann_backwards', color: 'default', start: 9, end: 2 },
      { id: 'ann_"><script>', color: 'default', start: 0, end: 5 },
    ];
    expect(markSnapshotHtml(html, nonsense)).toBe(html);
  });

  it('does not move the text the other highlights on the page are anchored in', () => {
    const html = [
      '<!doctype html>',
      '<html><head><title>Sleep</title><style>p{color:#111}</style></head>',
      '<body><h1>Why sleep matters</h1>',
      '<p>The first thing to understand is that the field rewards <b>reading code</b>',
      ' more than reading papers &mdash; by a distance.</p>',
      '<pre>def f():\n    return 1</pre>',
      '</body></html>',
    ].join('\n');
    const before = normalizeText(extractHtmlText(html));
    const marked = markSnapshotHtml(html, [
      highlight(html, 'rewards reading code more', { id: 'ann_a', color: 'tan' }),
      highlight(html, 'by a distance', { id: 'ann_b', color: 'ochre' }),
    ]);

    expect(normalizeText(extractHtmlText(marked))).toBe(before);
    expect(unmarked(marked)).toBe(html);
    expect(
      paintedRuns(marked)
        .map((run) => normalizeText(extractHtmlText(run)))
        .join(' '),
    ).toContain('rewards');
  });
});
