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
 * Every per-character rule normalization applies, written **as data** rather than as regular
 * expressions.
 *
 * The regexes below are derived from these tables, and so is the character-at-a-time walk in
 * `normalizeTextWithSource`. That is the point: the mapped walk exists so a highlight can be
 * painted back onto the bytes it was anchored in (`H10`), and two spellings of "which
 * characters fold to what" would be two alphabets claiming one `NORMALIZATION_VERSION`, and the
 * offsets would agree everywhere except on the one page containing a curly quote.
 *
 * Written as escapes rather than literals: these characters are invisible in an editor, so a
 * stray one pasted into this file would be undetectable in review.
 */

/**
 * Characters that carry no textual meaning and are dropped outright:
 * soft hyphen, zero-width space / non-joiner / joiner, word joiner, BOM.
 */
const ZERO_WIDTH_CHARS = '\u00ad\u200b\u200c\u200d\u2060\ufeff';
// Alternation rather than a character class: a zero-width joiner *inside* a class is what
// joins two emoji into one glyph, and reading it as a class is the mistake the rule is named
// for. Each of these is one character on its own and is matched as one.
const ZERO_WIDTH = new RegExp([...ZERO_WIDTH_CHARS].join('|'), 'g');

/**
 * Whitespace variants folded to a single ASCII space: NBSP, the U+2000-U+200A quad/em
 * spaces, narrow NBSP, medium mathematical space, ideographic space, tab, form feed and
 * vertical tab.
 */
const UNICODE_SPACE_CHARS =
  '\u00a0\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000\t\f\v';
const UNICODE_SPACE = new RegExp(`[${UNICODE_SPACE_CHARS}]`, 'g');

/** Quote and dash variants folded to ASCII so a quote survives a re-encode. */
const PUNCTUATION_FOLD_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['\u2018\u2019\u201a\u201b\u2032', "'"],
  ['\u201c\u201d\u201e\u201f\u2033', '"'],
  ['\u2010\u2011\u2012\u2013\u2014\u2015\u2212', '-'],
  ['\u2026', '...'],
];

const PUNCTUATION_FOLD: ReadonlyArray<readonly [RegExp, string]> = PUNCTUATION_FOLD_TABLE.map(
  ([chars, replacement]) => [new RegExp(`[${chars}]`, 'g'), replacement] as const,
);

/** The same table as a lookup, for the character-at-a-time walk. */
const PUNCTUATION_FOLD_BY_CHAR: ReadonlyMap<string, string> = new Map(
  PUNCTUATION_FOLD_TABLE.flatMap(([chars, replacement]) =>
    [...chars].map((char) => [char, replacement] as const),
  ),
);

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

// ---------------------------------------------------------------------------
// The same text, carrying where each character came from
// ---------------------------------------------------------------------------

/**
 * Text plus, for every one of its UTF-16 code units, the half-open range of the *source* it
 * was produced from.
 *
 * This is what makes a highlight paintable on the saved page itself (`H10`). An anchor's
 * offsets are into `normalizeText(extractHtmlText(html))` — a string with no tags, no
 * entities and no collapsible whitespace in it — and the marks have to be inserted into the
 * archive's own bytes, which have all three. The map is the only honest way back: nothing here
 * guesses, and a character with no source (the newline a `<p>` contributes) carries an empty
 * range and can hold no mark.
 *
 * `starts` and `ends` are always the same length as `text`.
 */
export interface TextWithSource {
  readonly text: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

/** A `TextWithSource` under construction. */
interface SourceBuilder {
  text: string;
  readonly starts: number[];
  readonly ends: number[];
}

function newBuilder(): SourceBuilder {
  return { text: '', starts: [], ends: [] };
}

/** Append one UTF-16 code unit together with the source range that produced it. */
function push(into: SourceBuilder, unit: string, from: number, to: number): void {
  into.text += unit;
  into.starts.push(from);
  into.ends.push(to);
}

/** Append a string whose every unit shares one source range (an entity, a folded ellipsis). */
function pushAll(into: SourceBuilder, units: string, from: number, to: number): void {
  // Indexed rather than `for…of`: iterating by code point would push one entry for a
  // surrogate pair and put `starts` permanently out of step with `text`.
  for (let i = 0; i < units.length; i += 1) {
    push(into, units[i] ?? '', from, to);
  }
}

/** Copy `[from, to)` of `source` across unchanged, ranges and all. */
function copyRange(into: SourceBuilder, source: TextWithSource, from: number, to: number): void {
  for (let i = from; i < to; i += 1) {
    push(into, source.text[i] ?? '', source.starts[i] ?? 0, source.ends[i] ?? 0);
  }
}

/**
 * `normalizeText`, carrying the map through.
 *
 * Every step below is the mapped twin of one line of `foldCharacters` / `normalizeText`, in
 * the same order and off the same tables. Where a rule turns several characters into one — a
 * CRLF, a run of spaces — the survivor's range spans all of them; where it turns one into
 * several — an ellipsis becoming three dots — each of them carries the one source range.
 */
export function normalizeTextWithSource(input: TextWithSource): TextWithSource {
  return trimWithSource(collapseWhitespaceWithSource(foldWithSource(composeWithSource(input))));
}

/**
 * NFC, segment by segment.
 *
 * Composition happens strictly inside a combining sequence — a starter plus the marks that
 * follow it — so normalizing each of those and concatenating gives the same answer as
 * normalizing the whole string, while keeping the map exact everywhere the sequence is a
 * single character. When a sequence does compose, its output characters all point at the whole
 * sequence, which is the truth: "é" written as `e` + U+0301 occupies both source characters.
 */
function composeWithSource(input: TextWithSource): TextWithSource {
  if (input.text.normalize('NFC') === input.text) return input;

  const out = newBuilder();
  for (const match of input.text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const from = match.index;
    const to = from + match[0].length;
    const composed = match[0].normalize('NFC');
    if (composed === match[0]) {
      copyRange(out, input, from, to);
    } else {
      pushAll(out, composed, input.starts[from] ?? 0, input.ends[to - 1] ?? 0);
    }
  }
  return out;
}

/** The character folds: CR/CRLF, zero-width, unicode spaces, quotes and dashes. */
function foldWithSource(input: TextWithSource): TextWithSource {
  const out = newBuilder();
  let i = 0;
  while (i < input.text.length) {
    const char = input.text[i] ?? '';
    const start = input.starts[i] ?? 0;
    if (char === '\r') {
      // `\r\n?` -> `\n`, before anything else, exactly as `foldCharacters` does it: a
      // zero-width character sitting between the two makes them two line breaks, not one.
      const paired = input.text[i + 1] === '\n';
      push(out, '\n', start, input.ends[paired ? i + 1 : i] ?? 0);
      i += paired ? 2 : 1;
      continue;
    }
    const end = input.ends[i] ?? 0;
    if (ZERO_WIDTH_CHARS.includes(char)) {
      i += 1;
      continue;
    }
    if (UNICODE_SPACE_CHARS.includes(char)) {
      push(out, ' ', start, end);
      i += 1;
      continue;
    }
    const folded = PUNCTUATION_FOLD_BY_CHAR.get(char);
    if (folded === undefined) push(out, char, start, end);
    else pushAll(out, folded, start, end);
    i += 1;
  }
  return out;
}

const WHITESPACE = /\s/;

/** `replace(/\s+/g, ' ')`: the space that survives a run spans the whole run. */
function collapseWhitespaceWithSource(input: TextWithSource): TextWithSource {
  const out = newBuilder();
  let i = 0;
  while (i < input.text.length) {
    if (!WHITESPACE.test(input.text[i] ?? '')) {
      copyRange(out, input, i, i + 1);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < input.text.length && WHITESPACE.test(input.text[end] ?? '')) end += 1;
    push(out, ' ', input.starts[i] ?? 0, input.ends[end - 1] ?? 0);
    i = end;
  }
  return out;
}

/** `trim()`. */
function trimWithSource(input: TextWithSource): TextWithSource {
  let from = 0;
  let to = input.text.length;
  while (from < to && WHITESPACE.test(input.text[from] ?? '')) from += 1;
  while (to > from && WHITESPACE.test(input.text[to - 1] ?? '')) to -= 1;
  if (from === 0 && to === input.text.length) return input;
  const out = newBuilder();
  copyRange(out, input, from, to);
  return out;
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

const CHARACTER_REFERENCE = /&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]{1,31});/g;

/**
 * What one character reference decodes to, or the reference itself when it decodes to nothing.
 *
 * Lone `&` and unknown names are left as written — this is text extraction, not a parser
 * conformance exercise, and inventing a replacement loses a character the reader can see.
 */
function decodeReference(match: string, body: string): string {
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
}

/**
 * Decode character references, carrying the map through. Runs *after* tag removal, never
 * before: decoding first would turn an escaped `&lt;script&gt;` in ordinary prose into markup
 * the scanner then strips, silently deleting text the page displayed.
 *
 * Every character a reference decodes to points at the whole `&…;`, which is what lets a
 * highlight covering it be painted over the reference rather than into the middle of it.
 */
function decodeReferencesWithSource(input: TextWithSource): TextWithSource {
  const out = newBuilder();
  let copied = 0;
  // `matchAll` iterates on its own clone, so the shared literal's `lastIndex` is untouched.
  for (const match of input.text.matchAll(CHARACTER_REFERENCE)) {
    const from = match.index;
    const to = from + match[0].length;
    copyRange(out, input, copied, from);
    const decoded = decodeReference(match[0], match[1] ?? '');
    if (decoded === match[0]) copyRange(out, input, from, to);
    else pushAll(out, decoded, input.starts[from] ?? 0, input.ends[to - 1] ?? 0);
    copied = to;
  }
  copyRange(out, input, copied, input.text.length);
  return out;
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
  return extractHtmlTextWithSource(html).text;
}

/** Whitespace a source newline counts as, outside `<pre>`. Mirrors `/[ \t\r\n\f\v]/`. */
const COLLAPSIBLE = ' \t\r\n\f\v';

/**
 * `extractHtmlText`, carrying the map back into the archive's bytes.
 *
 * There is one scanner and one entity table, and this is them: `extractHtmlText` is this
 * function's `.text`. A second scanner that only tracked offsets would be a second answer to
 * "what counts as prose here", and the day the two disagreed a highlight would be painted a
 * paragraph away from the words it was made on — with no symptom anywhere else.
 *
 * A character the markup contributes but the source does not contain — the newline a `<p>`
 * stands for — is emitted with an empty range at the tag, so it can never carry a mark.
 */
export function extractHtmlTextWithSource(html: string): TextWithSource {
  const out = newBuilder();
  let index = 0;
  /** Depth of open `<pre>` elements: inside one, source whitespace is content. */
  let preDepth = 0;

  /**
   * Append a run of text. Outside `<pre>`, a newline in the source is collapsible
   * whitespace, not structure — a paragraph the author hard-wrapped at 80 columns is one
   * paragraph, and passing its line breaks through would split it into several.
   */
  const appendText = (from: number, to: number): void => {
    let at = from;
    while (at < to) {
      const char = html[at] ?? '';
      if (preDepth === 0 && COLLAPSIBLE.includes(char)) {
        let run = at + 1;
        while (run < to && COLLAPSIBLE.includes(html[run] ?? '')) run += 1;
        push(out, ' ', at, run);
        at = run;
        continue;
      }
      push(out, char, at, at + 1);
      at += 1;
    }
  };

  while (index < html.length) {
    const next = html.indexOf('<', index);
    if (next === -1) {
      appendText(index, html.length);
      break;
    }
    appendText(index, next);

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
      push(out, '<', next, next + 1);
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
        push(out, '\n', index, index);
        continue;
      }
    }
    if (name === 'pre') {
      preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
    }
    if (BLOCK_ELEMENTS.has(name)) push(out, '\n', index, index);
  }

  return decodeReferencesWithSource(out);
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
