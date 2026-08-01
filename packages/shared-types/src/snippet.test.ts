/**
 * The two ends of `SearchResult.snippet` agreeing about what is in it.
 *
 * The bug these guard is not a crash: a search page that printed the delimiters straight out
 * still listed the right hits, in the right order, with the right text — and drew a pair of
 * tofu boxes around every match, because a private-use code point has no glyph. So the
 * property that matters is total coverage: every character of a snippet comes out in exactly
 * one segment and no delimiter ever survives into one.
 */
import { describe, expect, it } from 'vitest';
import { SNIPPET_CLOSE, SNIPPET_OPEN, snippetSegments, stripSnippetMarkers } from './snippet.js';

const marked = (text: string): string => `${SNIPPET_OPEN}${text}${SNIPPET_CLOSE}`;

describe('snippetSegments', () => {
  it('splits a marked snippet into plain and matched runs, in order', () => {
    const snippet = `…the ${marked('spacing')} effect and ${marked('spacing')} alone`;
    expect(snippetSegments(snippet)).toEqual([
      { text: '…the ', matched: false },
      { text: 'spacing', matched: true },
      { text: ' effect and ', matched: false },
      { text: 'spacing', matched: true },
      { text: ' alone', matched: false },
    ]);
  });

  it('never lets a delimiter through into a segment, however the text is shaped', () => {
    const cases = [
      '',
      'nothing matched here',
      marked('everything'),
      `${SNIPPET_OPEN}unclosed to the end`,
      `stray close${SNIPPET_CLOSE} and on`,
      `${SNIPPET_OPEN}${SNIPPET_CLOSE}empty run`,
      `${marked('a')}${marked('b')}`,
    ];
    for (const snippet of cases) {
      const segments = snippetSegments(snippet);
      for (const segment of segments) {
        expect(segment.text).not.toContain(SNIPPET_OPEN);
        expect(segment.text).not.toContain(SNIPPET_CLOSE);
        expect(segment.text.length).toBeGreaterThan(0);
      }
      // Every character survives exactly once: the drawn row says what the index found.
      expect(segments.map((segment) => segment.text).join('')).toBe(stripSnippetMarkers(snippet));
    }
  });

  it('reads a run that opens without closing as matched to the end', () => {
    expect(snippetSegments(`before ${SNIPPET_OPEN}after`)).toEqual([
      { text: 'before ', matched: false },
      { text: 'after', matched: true },
    ]);
  });
});
