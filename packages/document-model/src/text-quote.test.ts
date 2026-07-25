import { describe, expect, it } from 'vitest';
import {
  createQuoteSelector,
  levenshtein,
  resolveTextQuote,
  similarity,
} from './text-quote.js';

const PAGE =
  'Introduction. The mitochondrion is the powerhouse of the cell. ' +
  'We revisit this claim in light of recent evidence. ' +
  'The mitochondrion is the powerhouse of the cell, as every textbook says.';

describe('createQuoteSelector', () => {
  it('[T06] captures the exact text with surrounding context', () => {
    const start = PAGE.indexOf('powerhouse');
    const selector = createQuoteSelector(PAGE, start, start + 'powerhouse'.length, 10);
    expect(selector.exact).toBe('powerhouse');
    expect(selector.prefix).toBe(PAGE.slice(start - 10, start));
    expect(selector.suffix).toBe(PAGE.slice(start + 10, start + 20));
  });

  it('[T06] clamps context at document boundaries', () => {
    const selector = createQuoteSelector(PAGE, 0, 12, 50);
    expect(selector.prefix).toBe('');
    expect(selector.exact).toBe('Introduction');
  });
});

describe('resolveTextQuote', () => {
  it('[T06] resolves at the recorded offsets when nothing changed', () => {
    const start = PAGE.indexOf('recent evidence');
    const quote = createQuoteSelector(PAGE, start, start + 15);
    const result = resolveTextQuote(PAGE, quote, { start, end: start + 15 });

    expect(result).not.toBeNull();
    expect(result?.strategy).toBe('exact-position');
    expect(result?.position).toEqual({ start, end: start + 15 });
    expect(result?.confidence).toBeGreaterThan(0.9);
  });

  it('[T06] relocates a quote after text was inserted before it', () => {
    const start = PAGE.indexOf('recent evidence');
    const quote = createQuoteSelector(PAGE, start, start + 15);
    const shifted = `A new opening sentence was added here. ${PAGE}`;

    const result = resolveTextQuote(shifted, quote, { start, end: start + 15 });

    expect(result).not.toBeNull();
    expect(result?.strategy).toBe('quote-relocated');
    expect(shifted.slice(result!.position.start, result!.position.end)).toBe(
      'recent evidence',
    );
  });

  it('[T06] disambiguates duplicated text using prefix and suffix context', () => {
    // "the powerhouse of the cell" appears twice; context must pick the right one.
    const needle = 'the powerhouse of the cell';
    const secondStart = PAGE.lastIndexOf(needle);
    const quote = createQuoteSelector(PAGE, secondStart, secondStart + needle.length);

    // Hint deliberately points at the FIRST occurrence to prove context wins over proximity.
    const firstStart = PAGE.indexOf(needle);
    const result = resolveTextQuote(PAGE, quote, {
      start: firstStart,
      end: firstStart + needle.length,
    });

    expect(result).not.toBeNull();
    expect(result?.position.start).toBe(secondStart);
  });

  it('[T06] falls back to fuzzy matching when the quote was lightly edited', () => {
    const original = 'the powerhouse of the cell';
    const start = PAGE.indexOf(original);
    const quote = createQuoteSelector(PAGE, start, start + original.length);

    // Typo introduced during a re-extraction. Both occurrences must be edited, otherwise
    // the untouched copy would still match verbatim and never exercise the fuzzy path.
    const edited = PAGE.replaceAll(
      'the powerhouse of the cell',
      'the powerhosue of the cell',
    );
    const result = resolveTextQuote(edited, quote, { start, end: start + original.length });

    expect(result).not.toBeNull();
    expect(result?.strategy).toBe('context-fuzzy');
    expect(result?.confidence).toBeLessThan(0.75);
  });

  it('[T06] returns null when the quote is genuinely gone', () => {
    const quote = {
      exact: 'a sentence that never appeared anywhere in this document at all',
      prefix: 'nothing ',
      suffix: ' nothing',
    };
    expect(resolveTextQuote(PAGE, quote)).toBeNull();
  });

  it('[T06] returns null for an empty quote rather than matching everything', () => {
    expect(resolveTextQuote(PAGE, { exact: '', prefix: '', suffix: '' })).toBeNull();
  });

  it('[T06] reports lower confidence for an ambiguous relocation than an exact hit', () => {
    const needle = 'the powerhouse of the cell';
    const first = PAGE.indexOf(needle);
    const ambiguous = resolveTextQuote(
      PAGE,
      { exact: needle, prefix: '', suffix: '' },
      { start: first, end: first + needle.length },
    );
    const exact = resolveTextQuote(
      PAGE,
      createQuoteSelector(PAGE, first, first + needle.length),
      { start: first, end: first + needle.length },
    );
    expect(ambiguous?.confidence).toBeLessThan(exact!.confidence);
  });
});

describe('levenshtein and similarity', () => {
  it('[T06] computes a known edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('[T06] treats identical strings as distance zero and similarity one', () => {
    expect(levenshtein('same', 'same')).toBe(0);
    expect(similarity('same', 'same')).toBe(1);
  });

  it('[T06] respects the early-exit ceiling', () => {
    expect(levenshtein('abcdefgh', 'zzzzzzzz', 2)).toBeGreaterThan(2);
  });
});
