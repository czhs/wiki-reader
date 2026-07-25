import { describe, expect, it } from 'vitest';
import type { PdfReaderSelection } from '@wr/shared-types';
import {
  createPdfAnchor,
  deserializePdfAnchor,
  resolvePdfAnchor,
  serializePdfAnchor,
} from './pdf-anchor.js';

const PAGE_TEXT =
  'Section 3. Results. We observe a consistent improvement across all five benchmarks. ' +
  'The effect is strongest on the held-out split, where accuracy rises by 4.2 points.';

const CONTENT_HASH = 'sha256:abc123';

function selectionFor(needle: string): PdfReaderSelection {
  const start = PAGE_TEXT.indexOf(needle);
  if (start < 0) throw new Error(`test setup: ${needle} not in page text`);
  return {
    kind: 'pdf',
    pageIndex: 4,
    rects: [{ x1: 0.12, y1: 0.33, x2: 0.78, y2: 0.36 }],
    text: needle,
    pageText: PAGE_TEXT,
    position: { start, end: start + needle.length },
  };
}

describe('createPdfAnchor', () => {
  it('[T04] records page index, rects, quote, context, and both hashes', () => {
    const anchor = createPdfAnchor({
      selection: selectionFor('consistent improvement'),
      contentHash: CONTENT_HASH,
    });

    expect(anchor.kind).toBe('pdf');
    expect(anchor.pageIndex).toBe(4);
    expect(anchor.rects).toHaveLength(1);
    expect(anchor.quote.exact).toBe('consistent improvement');
    expect(anchor.quote.prefix.length).toBeGreaterThan(0);
    expect(anchor.quote.suffix.length).toBeGreaterThan(0);
    expect(anchor.pageTextHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(anchor.contentHash).toBe(CONTENT_HASH);
  });

  it('[T04] stores normalized rectangles only, never viewport pixels', () => {
    const anchor = createPdfAnchor({
      selection: selectionFor('held-out split'),
      contentHash: CONTENT_HASH,
    });
    for (const rect of anchor.rects) {
      for (const value of [rect.x1, rect.y1, rect.x2, rect.y2]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('[T04] records offsets into the normalized page text', () => {
    const anchor = createPdfAnchor({
      selection: selectionFor('four point two'.replace('four point two', 'accuracy rises')),
      contentHash: CONTENT_HASH,
    });
    expect(PAGE_TEXT.slice(anchor.position.start, anchor.position.end)).toBe(
      'accuracy rises',
    );
  });
});

describe('serializePdfAnchor / deserializePdfAnchor', () => {
  it('[T04] round-trips an anchor without loss', () => {
    const anchor = createPdfAnchor({
      selection: selectionFor('five benchmarks'),
      contentHash: CONTENT_HASH,
    });
    expect(deserializePdfAnchor(serializePdfAnchor(anchor))).toEqual(anchor);
  });

  it('[T04] rejects a malformed anchor rather than accepting it silently', () => {
    expect(() => deserializePdfAnchor('{"kind":"pdf","version":1}')).toThrow();
  });

  it('[T04] rejects rectangles outside the normalized range', () => {
    const anchor = createPdfAnchor({
      selection: selectionFor('five benchmarks'),
      contentHash: CONTENT_HASH,
    });
    const corrupted = JSON.stringify({
      ...anchor,
      rects: [{ x1: 0, y1: 0, x2: 1200, y2: 800 }],
    });
    expect(() => deserializePdfAnchor(corrupted)).toThrow();
  });
});

describe('resolvePdfAnchor', () => {
  it('[T04] resolves exactly when the page is unchanged', () => {
    const anchor = createPdfAnchor({
      selection: selectionFor('consistent improvement'),
      contentHash: CONTENT_HASH,
    });

    const resolved = resolvePdfAnchor({
      anchor,
      pageText: PAGE_TEXT,
      contentHash: CONTENT_HASH,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.strategy).toBe('exact-position');
    expect(resolved?.confidence).toBe(1);
    expect(resolved?.location.kind).toBe('pdf');
    if (resolved?.location.kind === 'pdf') {
      expect(resolved.location.pageIndex).toBe(4);
      expect(resolved.location.rects).toHaveLength(1);
    }
  });

  it('[T04] relocates and drops stale geometry when the page text shifted', () => {
    const anchor = createPdfAnchor({
      selection: selectionFor('held-out split'),
      contentHash: CONTENT_HASH,
    });

    const revised = `A newly inserted opening sentence. ${PAGE_TEXT}`;
    const resolved = resolvePdfAnchor({
      anchor,
      pageText: revised,
      contentHash: 'sha256:different',
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.strategy).toBe('quote-relocated');
    if (resolved?.location.kind === 'pdf') {
      // Geometry is no longer trustworthy, so it must not be reused.
      expect(resolved.location.rects).toBeUndefined();
      expect(resolved.location.textRange).toBeDefined();
      const range = resolved.location.textRange!;
      expect(revised.slice(range.start, range.end)).toBe('held-out split');
    }
  });

  it('[T04] returns null for a genuinely broken anchor instead of guessing', () => {
    const anchor = createPdfAnchor({
      selection: selectionFor('five benchmarks'),
      contentHash: CONTENT_HASH,
    });

    const unrelated =
      'This replacement page discusses an entirely different topic with no overlap at all.';
    expect(
      resolvePdfAnchor({ anchor, pageText: unrelated, contentHash: 'sha256:other' }),
    ).toBeNull();
  });

  it('[T04] survives whitespace-only re-extraction differences', () => {
    const anchor = createPdfAnchor({
      selection: selectionFor('consistent improvement'),
      contentHash: CONTENT_HASH,
    });

    // A second extraction run emits different line breaks and spacing.
    const reExtracted = PAGE_TEXT.replace(/ /g, '  ').replace(/\. /g, '.\n');
    const resolved = resolvePdfAnchor({
      anchor,
      pageText: reExtracted,
      contentHash: CONTENT_HASH,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.confidence).toBe(1);
  });
});
