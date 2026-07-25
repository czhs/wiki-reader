import { describe, expect, it } from 'vitest';
import {
  NORMALIZATION_VERSION,
  joinPdfTextItems,
  normalizeText,
  normalizeTextPreservingParagraphs,
} from './normalize.js';

describe('normalizeText', () => {
  it('[T05] collapses every whitespace variant to a single space', () => {
    expect(normalizeText('a   b\tc\r\nd')).toBe('a b c d');
  });

  it('[T05] strips zero-width and soft-hyphen characters', () => {
    expect(normalizeText('hy­phen​ated﻿')).toBe('hyphenated');
  });

  it('[T05] folds curly quotes, dashes and ellipses to ASCII', () => {
    expect(normalizeText('“quoted” — it’s here…')).toBe(
      '"quoted" - it\'s here...',
    );
  });

  it('[T05] applies NFC composition so decomposed input matches composed input', () => {
    const decomposed = 'étude';
    const composed = 'étude';
    expect(normalizeText(decomposed)).toBe(normalizeText(composed));
  });

  it('[T05] is idempotent', () => {
    const messy = '  “A—B”    c­d\r\n\r\n e ';
    const once = normalizeText(messy);
    expect(normalizeText(once)).toBe(once);
  });

  it('[T05] trims leading and trailing whitespace', () => {
    expect(normalizeText('   padded   ')).toBe('padded');
  });

  it('[T05] produces identical output for the same text extracted two ways', () => {
    // The same sentence as PDF.js might emit it vs. as the DOM would.
    const fromPdf = 'The quick brown\nfox  jumps';
    const fromDom = 'The quick brown fox jumps';
    expect(normalizeText(fromPdf)).toBe(normalizeText(fromDom));
  });

  it('[T05] declares a normalization version so anchors can detect algorithm drift', () => {
    expect(NORMALIZATION_VERSION).toBeGreaterThan(0);
  });
});

describe('normalizeTextPreservingParagraphs', () => {
  it('[T05] keeps one newline between paragraphs and collapses the rest', () => {
    expect(normalizeTextPreservingParagraphs('one\n\n\ntwo   three')).toBe('one\ntwo three');
  });
});

describe('joinPdfTextItems', () => {
  it('[T05] repairs words hyphenated across a line break', () => {
    const items = [
      { str: 'hyphen-', hasEOL: true },
      { str: 'ation is annoying' },
    ];
    expect(normalizeText(joinPdfTextItems(items))).toBe('hyphenation is annoying');
  });

  it('[T05] leaves genuine hyphenated compounds intact', () => {
    const items = [{ str: 'well-known result' }];
    expect(normalizeText(joinPdfTextItems(items))).toBe('well-known result');
  });

  it('[T05] does not rejoin across a capitalised line start', () => {
    const items = [{ str: 'end-', hasEOL: true }, { str: 'Start' }];
    expect(joinPdfTextItems(items)).toBe('end-\nStart');
  });
});
