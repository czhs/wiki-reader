/**
 * Selection -> anchor, at the level where the arithmetic lives.
 *
 * The claim being tested is the one the whole highlight feature rests on: a selection made
 * in the reader produces an anchor that resolves back to the same span of the *same* text
 * the indexer saw. So these tests build page text with `buildPageText` — the very function
 * the extraction worker uses — and then round-trip through `createPdfAnchor` and
 * `resolvePdfAnchor` rather than asserting on intermediate values.
 */
import { describe, expect, it } from 'vitest';
import { createPdfAnchor, normalizeText, resolvePdfAnchor } from '@wr/document-model';
import {
  buildPageText,
  buildPdfSelection,
  estimateNormalizedStart,
  normalizeRects,
} from '../src/selection.js';

const CONTENT_HASH = 'a'.repeat(64);

/** The shape PDF.js hands back, with `hasEOL` marking line ends. */
const PAGE_ITEMS = [
  { str: 'The Transformer uses multi-head attention in three ', hasEOL: false },
  { str: 'different ways: encoder-decoder attention, self-', hasEOL: true },
  { str: 'attention in the encoder, and masked self-attention', hasEOL: true },
  { str: 'in the decoder.', hasEOL: true },
];

const A4 = { left: 0, top: 0, right: 600, bottom: 800 };

describe('buildPageText', () => {
  it('[T04] joins text items exactly as the extraction worker does', () => {
    // Not a tautology: this is the assertion that the reader and the indexer agree. The
    // expected value is written out literally so a change to either side has to be
    // justified here rather than silently accommodated.
    //
    // Note "selfattention": see the known-limitation test below. It is asserted as-is
    // because what matters for anchoring is that both sides produce the *same* string.
    expect(buildPageText(PAGE_ITEMS)).toBe(
      'The Transformer uses multi-head attention in three different ways: encoder-decoder ' +
        'attention, selfattention in the encoder, and masked self-attention in the decoder.',
    );
  });

  it('[T05] strips the hyphen from a real compound broken across lines (known limitation)', () => {
    // `joinPdfTextItems` cannot tell a soft hyphen introduced by justification from a
    // hyphen that belongs to the word, so "self-\nattention" becomes "selfattention" while
    // "self-attention" on one line is left alone. Anchors are unaffected — the reader and
    // the indexer both see the joined form — but the indexed token differs from what a user
    // would type, so an FTS query for "self-attention" misses this occurrence.
    //
    // Recorded rather than silently fixed: the plausible repairs (keep the hyphen, or
    // consult the rest of the document for the unhyphenated form) each break a different
    // real case, and choosing between them is a spec decision. See docs/FAILURES.md.
    expect(buildPageText([{ str: 'self-', hasEOL: true }, { str: 'attention', hasEOL: false }])).toBe(
      'selfattention',
    );
    expect(buildPageText([{ str: 'self-attention is used', hasEOL: false }])).toBe(
      'self-attention is used',
    );
  });

  it('[T04] repairs a word hyphenated across a line break', () => {
    const text = buildPageText([
      { str: 'the atten-', hasEOL: true },
      { str: 'tion mechanism', hasEOL: false },
    ]);
    expect(text).toBe('the attention mechanism');
    expect(text).not.toContain('- ');
  });

  it('[T04] collapses to empty for a page with no text', () => {
    expect(buildPageText([])).toBe('');
    expect(buildPageText([{ str: '   ', hasEOL: false }])).toBe('');
  });
});

describe('normalizeRects', () => {
  it('[T04] converts viewport pixels to page-relative ratios', () => {
    const rects = normalizeRects([{ left: 60, top: 80, right: 300, bottom: 120 }], A4);
    expect(rects).toEqual([{ x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.15 }]);
  });

  it('[T04] is unchanged by zoom, because only ratios are kept', () => {
    const at100 = normalizeRects([{ left: 60, top: 80, right: 300, bottom: 120 }], A4);
    const at200 = normalizeRects(
      [{ left: 120, top: 160, right: 600, bottom: 240 }],
      { left: 0, top: 0, right: 1200, bottom: 1600 },
    );
    expect(at200).toEqual(at100);
  });

  it('[T04] survives a page scrolled off the top of the viewport', () => {
    // Same rectangle on the page, but the page box now has negative viewport coordinates.
    const rects = normalizeRects(
      [{ left: 60, top: -220, right: 300, bottom: -180 }],
      { left: 0, top: -300, right: 600, bottom: 500 },
    );
    expect(rects).toEqual([{ x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.15 }]);
  });

  it('[T04] drops the zero-area rectangles getClientRects emits at line boundaries', () => {
    const rects = normalizeRects(
      [
        { left: 60, top: 80, right: 300, bottom: 120 },
        { left: 300, top: 80, right: 300, bottom: 120 },
        { left: 60, top: 120, right: 300, bottom: 120 },
      ],
      A4,
    );
    expect(rects).toHaveLength(1);
  });

  it('[T04] clamps a rectangle that overhangs the page rather than emitting out-of-range values', () => {
    const [rect] = normalizeRects([{ left: -40, top: -10, right: 900, bottom: 1000 }], A4);
    expect(rect).toEqual({ x1: 0, y1: 0, x2: 1, y2: 1 });
  });

  it('[T04] returns nothing for a degenerate page box instead of dividing by zero', () => {
    expect(normalizeRects([{ left: 0, top: 0, right: 10, bottom: 10 }], {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    })).toEqual([]);
  });
});

describe('estimateNormalizedStart', () => {
  it('[T04] measures the normalized prefix, not the raw one', () => {
    const start = estimateNormalizedStart({
      itemTexts: ['The   Transformer  ', 'uses attention'],
      startItemIndex: 1,
      startOffsetInItem: 5,
    });
    // "The Transformer" + separator + "uses " once whitespace is collapsed.
    expect(start).toBe(normalizeText('The   Transformer   uses ').length);
  });

  it('[T04] returns 0 for a selection starting in the first item', () => {
    expect(
      estimateNormalizedStart({ itemTexts: ['abc', 'def'], startItemIndex: 0, startOffsetInItem: 0 }),
    ).toBe(0);
  });
});

describe('selection round-trip', () => {
  const pageText = buildPageText(PAGE_ITEMS);

  function selectionFor(exact: string, hintStart: number): ReturnType<typeof buildPdfSelection> {
    return buildPdfSelection({
      pageIndex: 2,
      pageText,
      selectedText: exact,
      rects: normalizeRects([{ left: 60, top: 80, right: 300, bottom: 120 }], A4),
      hintStart,
    });
  }

  it('[M11] produces an anchor that resolves back to the selected text', () => {
    const selection = selectionFor('masked self-attention', pageText.indexOf('masked'));
    expect(selection).not.toBeNull();

    const anchor = createPdfAnchor({ selection: selection!, contentHash: CONTENT_HASH });
    expect(anchor.quote.exact).toBe('masked self-attention');
    expect(anchor.pageIndex).toBe(2);

    const resolved = resolvePdfAnchor({ anchor, pageText, contentHash: CONTENT_HASH });
    expect(resolved).not.toBeNull();
    expect(resolved?.strategy).toBe('exact-position');
    const range = resolved?.location.kind === 'pdf' ? resolved.location.textRange : undefined;
    expect(pageText.slice(range?.start ?? 0, range?.end ?? 0)).toBe('masked self-attention');
  });

  it('[M11] lands on the right occurrence when the hint is only approximate', () => {
    // "attention" occurs four times. A hint that is off by a few characters must still pick
    // the occurrence the user actually dragged over — this is the case the estimate exists
    // for, since DOM offsets and normalized offsets never agree exactly.
    const trueStart = pageText.lastIndexOf('attention');
    const selection = selectionFor('attention', trueStart - 4);
    const anchor = createPdfAnchor({ selection: selection!, contentHash: CONTENT_HASH });

    expect(anchor.position.start).toBe(trueStart);
    const resolved = resolvePdfAnchor({ anchor, pageText, contentHash: CONTENT_HASH });
    expect(resolved?.location.kind === 'pdf' ? resolved.location.textRange?.start : null).toBe(
      trueStart,
    );
  });

  it('[M11] keeps the rectangles it was given, so the highlight paints where the user dragged', () => {
    const selection = selectionFor('encoder-decoder', pageText.indexOf('encoder-decoder'));
    const anchor = createPdfAnchor({ selection: selection!, contentHash: CONTENT_HASH });
    expect(anchor.rects).toEqual([{ x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.15 }]);
  });

  it('[M11] relocates by quote when the page text has shifted', () => {
    const selection = selectionFor('masked self-attention', pageText.indexOf('masked'));
    const anchor = createPdfAnchor({ selection: selection!, contentHash: CONTENT_HASH });

    // A re-import where a running header was added to the page: every offset moves.
    const shifted = normalizeText(`Preprint. Under review. ${pageText}`);
    const resolved = resolvePdfAnchor({ anchor, pageText: shifted, contentHash: 'b'.repeat(64) });

    expect(resolved).not.toBeNull();
    expect(resolved?.strategy).not.toBe('exact-position');
    const range = resolved?.location.kind === 'pdf' ? resolved.location.textRange : undefined;
    expect(shifted.slice(range?.start ?? 0, range?.end ?? 0)).toBe('masked self-attention');
  });

  it('[M11] reports a broken anchor rather than guessing when the text is gone', () => {
    const selection = selectionFor('masked self-attention', pageText.indexOf('masked'));
    const anchor = createPdfAnchor({ selection: selection!, contentHash: CONTENT_HASH });

    const replaced = 'An entirely different page about convolutional networks and pooling.';
    expect(resolvePdfAnchor({ anchor, pageText: replaced, contentHash: 'c'.repeat(64) })).toBeNull();
  });

  it('[M11] refuses a selection with no text or no rectangles', () => {
    expect(selectionFor('   ', 0)).toBeNull();
    expect(
      buildPdfSelection({ pageIndex: 0, pageText, selectedText: 'attention', rects: [], hintStart: 0 }),
    ).toBeNull();
  });

  it('[M11] clamps a hint past the end of the page text', () => {
    const selection = selectionFor('attention', pageText.length + 5_000);
    expect(selection?.position.start).toBeLessThanOrEqual(pageText.length);
  });
});
