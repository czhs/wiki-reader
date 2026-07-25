/**
 * Text normalization.
 *
 * Every character offset persisted in an anchor refers to *normalized* text. PDF text
 * layers and HTML DOM text both carry noise — soft hyphens, non-breaking spaces, ligatures,
 * collapsed whitespace — that differs between extraction runs and between the Readability
 * view and the original snapshot. Normalizing before computing offsets is what makes an
 * offset reproducible.
 *
 * Bump NORMALIZATION_VERSION whenever the output of `normalizeText` changes. Anchors record
 * the version they were created under so a mismatch can trigger re-resolution by quote
 * rather than trusting stale offsets.
 */

export const NORMALIZATION_VERSION = 1;

/**
 * Characters that carry no textual meaning and are dropped outright:
 * soft hyphen, zero-width space / non-joiner / joiner, word joiner, BOM.
 *
 * Written as escapes rather than literals: these characters are invisible in an editor, so
 * a stray one pasted into this file would be undetectable in review.
 */
const ZERO_WIDTH = /\u00ad|\u200b|\u200c|\u200d|\u2060|\ufeff/g;

/**
 * Whitespace variants folded to a single ASCII space: NBSP, the U+2000-U+200A quad/em
 * spaces, narrow NBSP, medium mathematical space, ideographic space, tab, form feed and
 * vertical tab.
 */
const UNICODE_SPACE = /[\u00a0\u2000-\u200a\u202f\u205f\u3000\t\f\v]/g;

/** Quote and dash variants folded to ASCII so a quote survives a re-encode. */
const PUNCTUATION_FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2018\u2019\u201a\u201b\u2032]/g, "'"],
  [/[\u201c\u201d\u201e\u201f\u2033]/g, '"'],
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-'],
  [/\u2026/g, '...'],
];

/**
 * Normalize text for offset computation and quote matching.
 *
 * Guarantees:
 * - Unicode NFC composition
 * - no zero-width or soft-hyphen characters
 * - all whitespace runs collapsed to a single U+0020
 * - CRLF and CR folded to LF *before* collapsing, so line structure does not leak
 * - curly quotes, dashes and ellipses folded to ASCII
 * - leading and trailing whitespace removed
 *
 * The function is idempotent: `normalizeText(normalizeText(x)) === normalizeText(x)`.
 */
export function normalizeText(input: string): string {
  let text = input.normalize('NFC');
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(ZERO_WIDTH, '');
  text = text.replace(UNICODE_SPACE, ' ');
  for (const [pattern, replacement] of PUNCTUATION_FOLD) {
    text = text.replace(pattern, replacement);
  }
  // Collapse every run of whitespace (including newlines) to one space.
  text = text.replace(/\s+/g, ' ');
  return text.trim();
}

/**
 * Normalize while preserving paragraph structure: runs of blank lines become a single
 * newline, other whitespace collapses to a space. Used for chunk text that is shown to the
 * user, where losing every line break would hurt readability.
 *
 * Offsets computed against this function are NOT interchangeable with `normalizeText`.
 */
export function normalizeTextPreservingParagraphs(input: string): string {
  let text = input.normalize('NFC');
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(ZERO_WIDTH, '');
  text = text.replace(UNICODE_SPACE, ' ');
  for (const [pattern, replacement] of PUNCTUATION_FOLD) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/[ ]*\n[ \n]*/g, '\n');
  text = text.replace(/[ ]{2,}/g, ' ');
  return text.trim();
}

/**
 * Join PDF text-layer items, repairing hyphenation across line breaks.
 *
 * PDF.js yields text items whose `hasEOL` marks a line end. A word broken across lines
 * appears as "hyphen-\nation"; naive joining produces "hyphen- ation", which then fails to
 * match the quote "hyphenation". This rejoins when a lowercase letter precedes the hyphen
 * and follows the break.
 */
export function joinPdfTextItems(
  items: ReadonlyArray<{ str: string; hasEOL?: boolean }>,
): string {
  let out = '';
  for (const item of items) {
    out += item.str;
    if (item.hasEOL === true) {
      out += '\n';
    }
  }
  // Repair hyphenation: "word-\nnext" -> "wordnext"
  out = out.replace(/([\p{Ll}])-\n([\p{Ll}])/gu, '$1$2');
  return out;
}
