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
/**
 * Everything both normalizations do before they disagree.
 *
 * The two below differ in exactly one decision — whether line structure survives — and had
 * the other five steps written out twice. Those five are what `NORMALIZATION_VERSION` is
 * about, so a change made to one copy and not the other would silently give the two functions
 * different alphabets while both still claimed the same version.
 */
function foldCharacters(input: string): string {
  let text = input.normalize('NFC');
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(ZERO_WIDTH, '');
  text = text.replace(UNICODE_SPACE, ' ');
  for (const [pattern, replacement] of PUNCTUATION_FOLD) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function normalizeText(input: string): string {
  // Collapse every run of whitespace (including newlines) to one space.
  return foldCharacters(input).replace(/\s+/g, ' ').trim();
}

/**
 * Normalize while preserving paragraph structure: runs of blank lines become a single
 * newline, other whitespace collapses to a space. Used for chunk text that is shown to the
 * user, where losing every line break would hurt readability.
 *
 * Offsets computed against this function are NOT interchangeable with `normalizeText`.
 */
export function normalizeTextPreservingParagraphs(input: string): string {
  return foldCharacters(input)
    .replace(/[ ]*\n[ \n]*/g, '\n')
    .replace(/[ ]{2,}/g, ' ')
    .trim();
}

/**
 * Elements whose content is not prose and must never reach the text layer. `script` and
 * `style` are the obvious two; `svg` and `math` carry markup whose text nodes are glyph
 * data, and `template`/`noscript` hold inert content the reader never sees.
 */
const RAW_TEXT_ELEMENTS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'iframe',
  'object',
  'head',
]);

/**
 * Elements that end a line of prose. Everything absent from this set is treated as inline,
 * so `<b>hyper</b><i>text</i>` extracts as "hypertext" rather than "hyper text" — inserting
 * a space there would break every anchor quote that spans a styled word.
 */
const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'title', 'tr', 'ul',
]);

/** The named entities that actually appear in prose. Numeric references cover the rest. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Escapes, not literals, for the reason given at ZERO_WIDTH: these characters are
  // invisible in an editor, so a mistyped one would be undetectable in review. They are
  // folded or dropped by `normalizeText` downstream, which is the point of decoding them.
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  shy: '\u00ad',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  middot: '·',
  bull: '•',
  times: '×',
  minus: '−',
  prime: '′',
  Prime: '″',
};

/**
 * Decode character references. Runs *after* tag removal, never before: decoding first would
 * turn an escaped `&lt;script&gt;` in ordinary prose into markup the scanner then strips,
 * silently deleting text the page displayed.
 *
 * Lone `&` and unknown names are left as written — this is text extraction, not a parser
 * conformance exercise, and inventing a replacement loses a character the reader can see.
 */
function decodeCharacterReferences(input: string): string {
  return input.replace(/&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]{1,31});/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // Surrogates and out-of-range values are not characters; keep the source text instead
      // of throwing from String.fromCodePoint on hostile input.
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match;
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/**
 * Extract the readable text from an HTML fragment or document.
 *
 * The counterpart to `joinPdfTextItems`: it produces *raw* text with line structure, which
 * the caller then puts through `normalizeText` (for anchor offsets) or
 * `normalizeTextPreservingParagraphs` (for chunk text shown to the reader). Keeping
 * extraction and normalization separate is what makes an offset computed over a saved page
 * comparable to one computed over a PDF.
 *
 * This is a scanner, not a regex sweep, because archived HTML is hostile input and
 * `/<[^>]*>/g` is wrong on the first attribute that contains a `>`: given
 * `<a title="a > b">text</a>` it stops at the quoted bracket and emits `b">text` as prose.
 * A malformed or truncated tag runs to the end of input and is dropped rather than reappearing
 * as text.
 *
 * It deliberately does not build a tree: no element nesting is tracked, so this cannot be
 * used to decide what is safe to *render*. Rendering an archived page is the sandboxed
 * iframe's job; this only ever produces text.
 */
export function extractHtmlText(html: string): string {
  let out = '';
  let index = 0;
  /** Depth of open `<pre>` elements: inside one, source whitespace is content. */
  let preDepth = 0;

  /**
   * Append a run of text. Outside `<pre>`, a newline in the source is collapsible
   * whitespace, not structure — a paragraph the author hard-wrapped at 80 columns is one
   * paragraph, and passing its line breaks through would split it into several.
   */
  const appendText = (text: string): void => {
    out += preDepth > 0 ? text : text.replace(/[ \t\r\n\f\v]+/g, ' ');
  };

  while (index < html.length) {
    const next = html.indexOf('<', index);
    if (next === -1) {
      appendText(html.slice(index));
      break;
    }
    appendText(html.slice(index, next));

    // Comments, doctypes and processing instructions carry no prose.
    if (html.startsWith('<!--', next)) {
      const end = html.indexOf('-->', next + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', next) || html.startsWith('<?', next)) {
      const end = html.indexOf('>', next);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const nameMatch = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(next, next + 64));
    if (nameMatch === null) {
      // A bare `<` that starts no tag is literal text — "a < b" is prose, not markup.
      out += '<';
      index = next + 1;
      continue;
    }
    const isClosing = nameMatch[1] === '/';
    const name = (nameMatch[2] ?? '').toLowerCase();

    const tagEnd = findTagEnd(html, next + nameMatch[0].length);
    if (tagEnd === -1) {
      // Truncated tag: the rest of the input is inside it, so none of it is prose.
      break;
    }
    index = tagEnd + 1;

    if (!isClosing && RAW_TEXT_ELEMENTS.has(name)) {
      // Self-closing form (`<svg />`) encloses nothing, so there is no content to skip.
      const selfClosing = html[tagEnd - 1] === '/';
      if (!selfClosing) {
        index = skipRawTextElement(html, index, name);
        out += '\n';
        continue;
      }
    }
    if (name === 'pre') {
      preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
    }
    if (BLOCK_ELEMENTS.has(name)) out += '\n';
  }

  return decodeCharacterReferences(out);
}

/** Index of the `>` closing a tag, skipping over quoted attribute values. */
function findTagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i += 1) {
    const char = html[i];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return i;
  }
  return -1;
}

/**
 * Skip to just past `</name ...>`. Nothing inside a raw-text element is prose, including
 * things that look like other tags — `<script>if (a<b) {}</script>` must not be mistaken for
 * markup, which is exactly why the HTML spec gives these elements their own tokenizer state.
 */
function skipRawTextElement(html: string, from: number, name: string): number {
  const pattern = new RegExp(`</${name}[\\s/>]`, 'i');
  const rest = html.slice(from);
  const match = pattern.exec(rest);
  if (match === null) return html.length;
  const closeEnd = findTagEnd(html, from + match.index + match[0].length - 1);
  return closeEnd === -1 ? html.length : closeEnd + 1;
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
