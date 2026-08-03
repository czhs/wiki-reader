/**
 * How a notebook says the things it used to say in markdown (criteria S04–S08).
 *
 * The notebook's source language is Typst: the paper is drafted in the tool papers are set
 * in. Everything else in the tree that reads markdown — the corpus reader, the journal, the
 * anchoring pipeline — keeps markdown, and this module is deliberately *beside* `markdown.ts`
 * rather than a branch inside it. `INLINE_CONSTRUCT_RE`, `projectText` and `foldBlock` are
 * markdown's rules and stay markdown's; widening them to understand Typst is how a highlight
 * comes to be unpaintable on the document it was made in.
 *
 * The milestone asks for one decision, taken once, about three things that have to survive the
 * language change. They are here, and only here:
 *
 * - **An excerpt** is `#quote(block: true, attribution: link("annotation://…")[…])[…]`. Typst's
 *   own quote element, so the HTML target emits `<blockquote cite="annotation://…">` with the
 *   attribution as a real `<a href>` beside it — which is the same shape the markdown excerpt
 *   rendered to, so the chip mechanism and `S03`'s promise carry over unchanged.
 * - **An `annotation://` / `document://` / `note://` chip** is `#link("<scheme>://<id>")[label]`.
 *   Typst passes an unknown scheme through untouched; the renderer reads the `href` back.
 * - **A wikilink** is `#link("wiki://<target>")[label]`. Markdown spells it `[[target]]`,
 *   which Typst has no syntax for; a scheme is what both languages can carry, and it means the
 *   Typst renderer resolves it through the same `WikilinkRenderer` the markdown one uses.
 *
 * Everything here is pure and string-shaped, so it is testable without a compiler and safe in
 * the renderer. The compiler itself is main-process only (`apps/desktop/src/main/typst.ts`).
 */
import { AnnotationIdSchema, DocumentIdSchema } from '@wr/shared-types';
import { collapseWhitespace } from './display.js';
import { formatInternalLink } from './internal-links.js';

/**
 * Which language a notebook's body is written in.
 *
 * Stored per notebook (`questions.body_format`), because the migration decision is that
 * **nothing already written is converted**: a body typed as markdown goes on being markdown
 * and goes on rendering through the markdown pipeline, and only notebooks minted after the
 * switch are Typst. A converter that rewrote prose in place would be a guess about somebody's
 * paper, and a guess that cannot be checked before it has already overwritten the original.
 */
export const NOTEBOOK_BODY_FORMATS = ['markdown', 'typst'] as const;
export type NotebookBodyFormat = (typeof NOTEBOOK_BODY_FORMATS)[number];

/** What a notebook minted today is written in. */
export const DEFAULT_NOTEBOOK_BODY_FORMAT: NotebookBodyFormat = 'typst';

/**
 * A Typst string literal.
 *
 * Only `\` and `"` can end one, and both are escaped rather than stripped: a file called
 * `Notes "draft"` is somebody's file and should read as itself.
 */
export function typstString(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

/**
 * Text, as content, with nothing in it that can start a construct.
 *
 * `selectedText` is the one input on this path that a PDF or a page off the open web controls,
 * and Typst content is markup like markdown's is — a quoted paper containing `#link(...)` would
 * otherwise render a second attribution chip pointing wherever the document said. So every
 * character Typst gives meaning to inside content is escaped.
 *
 * Typst's escape is `\` before the character, and `\` before an ordinary character is an error,
 * so the set is exact rather than generous: `#` starts code, `$` starts maths, `*`/`_` are
 * emphasis, `` ` `` is raw, `@` is a reference, `<`/`>` are labels, `[`/`]` are content blocks,
 * `~` is a non-breaking space, `\` is the escape itself, and `/`, `-`, `+`, `=` lead a list
 * item or a heading — those four only where they lead a line, which is the only place Typst
 * reads them that way, so a sentence with a hyphen in it still reads as the sentence.
 *
 * `~` was missing until the milestone-8 audit measured it: a quotation saying *"about ~50% of
 * runs"* typeset as *"about  50% of runs"*, the tilde gone. Everything else the set leaves
 * alone is typography a quotation can survive (`--` sets an en dash); a deleted character is
 * not, so the rule for this set is that a character Typst reads is escaped whether or not what
 * it does looks harmless.
 */
export function escapeTypstText(text: string): string {
  return text
    .replace(/([\\#$*_`@<>[\]~])/gu, '\\$1')
    .replace(/^(\s*)([-+/=])/gmu, '$1\\$2');
}

/** `]` would close the content block early; the rest is the same rule as anywhere else. */
function labelText(title: string, whenNameless: string): string {
  const collapsed = collapseWhitespace(title);
  return collapsed === '' ? whenNameless : escapeTypstText(collapsed);
}

/**
 * Blank lines end a block in Typst exactly as they do in markdown, and `parseBlocks` splits on
 * them, so a quote that runs over several paragraphs has to arrive as one block or the
 * researcher gets half a citation. Collapsed to single newlines, which Typst renders as a
 * space — the same thing markdown does with a soft break.
 */
function oneBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * The Typst for one excerpt block (`S03` in the new language, `S04`, `S09`).
 *
 * `#quote(block: true, attribution: …)` rather than a hand-built blockquote: it is Typst's own
 * element for exactly this, the HTML target gives it a `<blockquote cite="…">` carrying the
 * annotation link, and a researcher who edits the block is editing a construct their own Typst
 * knowledge covers rather than this app's private convention.
 */
export function excerptTypst(excerpt: {
  readonly annotationId: string;
  readonly selectedText: string;
  readonly sourceTitle: string;
}): string {
  const parsed = AnnotationIdSchema.safeParse(excerpt.annotationId);
  const body = oneBlock(escapeTypstText(excerpt.selectedText.trim()));
  const quoted = body === '' ? '' : body;
  const label = labelText(excerpt.sourceTitle, 'the highlight');
  if (!parsed.success) return `#quote(block: true, attribution: [${label}])[${quoted}]`;
  const href = formatInternalLink({ scheme: 'annotation', annotationId: parsed.data });
  return `#quote(block: true, attribution: link(${typstString(href)})[${label}])[${quoted}]`;
}

/** The Typst for a whole file landing in a page (`P06` in the new language). */
export function documentReferenceTypst(reference: {
  readonly documentId: string;
  readonly title: string;
}): string {
  const parsed = DocumentIdSchema.safeParse(reference.documentId);
  const label = labelText(reference.title, 'the file');
  if (!parsed.success) return label;
  const href = formatInternalLink({ scheme: 'document', documentId: parsed.data });
  return `#link(${typstString(href)})[${label}]`;
}

/**
 * A wikilink, in Typst.
 *
 * `wiki://` is not an internal link scheme — it never reaches `parseInternalLink` — it is the
 * spelling the Typst renderer recognises and hands to the same `WikilinkRenderer` that
 * markdown's `[[target]]` goes through, so a wanted page is still a wanted page here.
 */
export const TYPST_WIKILINK_SCHEME = 'wiki://';

export function wikilinkTypst(target: string, alias?: string): string {
  const label = labelText(alias ?? target, 'a page');
  return `#link(${typstString(`${TYPST_WIKILINK_SCHEME}${collapseWhitespace(target)}`)})[${label}]`;
}

/** The target behind a `wiki://…` href, or null when the href is not one. */
export function parseWikilinkHref(href: string): string | null {
  if (!href.startsWith(TYPST_WIKILINK_SCHEME)) return null;
  const target = href.slice(TYPST_WIKILINK_SCHEME.length).trim();
  return target === '' ? null : target;
}

// ---------------------------------------------------------------------------
// Figures (`S06`)
// ---------------------------------------------------------------------------

/**
 * Where a picture's bytes are mounted for the compiler.
 *
 * A **virtual** directory: nothing is ever written there and no such path exists on disk. The
 * main process resolves an internal file id to bytes and hands the compiler
 * `mapShadow('<workspace>/img/<file id>', bytes)`, so the name inside the document is the file
 * id and nothing else — the renderer never receives a path and there is none here to build one
 * out of, which is the same invariant `rrfile://` keeps for the window.
 */
export const TYPST_IMAGE_ROOT = '/img/';

/** An image block, taken apart — the Typst counterpart of `parseImage`. */
export interface TypstImage {
  readonly fileId: string;
  readonly alt: string;
  /** The width it was dragged to, in points. `null` means it has never been resized. */
  readonly width: number | null;
}

/**
 * The Typst for a figure.
 *
 * The width is a **named argument** rather than a word smuggled into a title slot, which is
 * what the markdown spelling had to do (`P11`). Same property kept: it lives in the source,
 * there is no second store, and anything else reading the file sees the same figure at the
 * same width.
 */
export function imageTypst(image: {
  readonly fileId: string;
  readonly alt?: string | undefined;
  readonly width?: number | null | undefined;
}): string {
  const alt = collapseWhitespace(image.alt ?? '');
  const parts = [typstString(`${TYPST_IMAGE_ROOT}${image.fileId}`)];
  if (alt !== '') parts.push(`alt: ${typstString(alt)}`);
  if (image.width !== null && image.width !== undefined) {
    parts.push(`width: ${String(Math.round(image.width))}pt`);
  }
  return `#image(${parts.join(', ')})`;
}

const IMAGE_CALL = /^#image\(\s*"([^"\\]*)"\s*((?:,[^)]*)?)\)$/u;
const ALT_ARG = /alt:\s*"([^"\\]*)"/u;
const WIDTH_ARG = /width:\s*(\d+(?:\.\d+)?)pt/u;

/** Read a figure block's parts, or `null` when the block is not exactly one figure. */
export function parseTypstImage(src: string): TypstImage | null {
  const call = IMAGE_CALL.exec(src.trim());
  if (call === null) return null;
  const target = call[1] ?? '';
  if (!target.startsWith(TYPST_IMAGE_ROOT)) return null;
  const rest = call[2] ?? '';
  const width = WIDTH_ARG.exec(rest);
  return {
    fileId: target.slice(TYPST_IMAGE_ROOT.length),
    alt: ALT_ARG.exec(rest)?.[1] ?? '',
    width: width === null ? null : Math.round(Number(width[1])),
  };
}

/** The same figure at a new width — `null` takes the width off again (`P11`). */
export function withTypstImageWidth(src: string, width: number | null): string {
  const image = parseTypstImage(src);
  if (image === null) return src;
  return imageTypst({ fileId: image.fileId, alt: image.alt, width });
}

/** A block that is nothing but one figure is a figure, not prose. */
export function isTypstImageBlock(src: string): boolean {
  return parseTypstImage(src) !== null;
}

// ---------------------------------------------------------------------------
// The page, and what it may not do
// ---------------------------------------------------------------------------

/**
 * A Typst page's sections, in the order they are written.
 *
 * The counterpart of `notebookSections`, and deliberately not a branch inside it: that one
 * reads markdown's AST and this one reads lines, because Typst's headings are `=` at the start
 * of a line and the one thing that can lie about them is a raw block. So fences are skipped,
 * which is the same guard `notebookSections` gets for free from its parser, and nothing else
 * here pretends to parse Typst.
 *
 * Like markdown's, a page's sections are its *shallowest* headings, so a paper written with
 * `=` throughout has the same shape as one written with `==`.
 */
export interface TypstSection {
  readonly heading: string;
  readonly depth: number;
}

export function typstSections(source: string): TypstSection[] {
  const found: TypstSection[] = [];
  let inFence = false;
  for (const line of source.split('\n')) {
    if (/^\s{0,3}`{3,}/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^(=+)\s+(.*\S)\s*$/u.exec(line);
    if (heading === null) continue;
    found.push({ heading: heading[2] ?? '', depth: (heading[1] ?? '=').length });
  }
  const top = found.reduce<number | null>(
    (min, section) => (min === null || section.depth < min ? section.depth : min),
    null,
  );
  return top === null ? [] : found.filter((section) => section.depth === top);
}

/**
 * Typst's HTML export starts the document's headings at `<h2>`, keeping `<h1>` for the page
 * itself, so a `=` heading is an `h2`. The outline scrolls by tag name, and getting this wrong
 * means every jump lands nowhere.
 */
export const TYPST_HEADING_TAG_OFFSET = 1;

/** What a blank Typst page opens on — the same template, spelled with `=`. */
export function blankNotebookTypst(sections: readonly string[]): string {
  return `${sections.map((heading) => `= ${escapeTypstText(heading)}\n`).join('\n')}`;
}

// ---------------------------------------------------------------------------
// Reading Typst without parsing it
// ---------------------------------------------------------------------------

/**
 * The spans of a Typst source that are **not executed**: raw blocks and comments.
 *
 * Both guards below have to know where they are — a `#import` shown inside ` ``` ` is an
 * example of one, not one, and neither a bracket nor a quote inside a comment closes anything.
 * A run of *n* backticks opens raw and the next run of *n* closes it, in code mode and in
 * content mode alike, so one rule covers both spellings.
 *
 * This is deliberately not a Typst parser. It knows three kinds of span it must skip and
 * nothing else about the language, which is the most that can be relied on without pulling the
 * grammar in — and each caller below is written to fail *closed* when it is unsure.
 */
function skipUnexecuted(source: string, at: number): number | null {
  const here = source[at];
  if (here === '/' && source[at + 1] === '/') {
    const end = source.indexOf('\n', at);
    return end === -1 ? source.length : end;
  }
  if (here === '/' && source[at + 1] === '*') {
    const end = source.indexOf('*/', at + 2);
    return end === -1 ? source.length : end + 2;
  }
  if (here === '`') {
    let run = 0;
    while (source[at + run] === '`') run += 1;
    const marker = '`'.repeat(run);
    const end = source.indexOf(marker, at + run);
    return end === -1 ? source.length : end + marker.length;
  }
  if (here === '"') {
    let index = at + 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character === '"') return index + 1;
      index += 1;
    }
    return source.length;
  }
  return null;
}

/**
 * How many brackets a Typst source leaves open (`S04`, `S06`).
 *
 * `parseBlocks` ends a block at a blank line, which is markdown's rule and Typst's rule for
 * *prose* — but Typst has constructs that span one, and the milestone-8 audit found that
 * `#figure(image(…),\n\n  caption: […])` was split into two halves, neither of which compiles.
 * So a chunk that opened a construct is not finished at a blank line, and this is how the
 * splitter asks. Brackets inside strings, comments and raw blocks do not count.
 */
export function typstOpenDepth(source: string): number {
  let depth = 0;
  let index = 0;
  while (index < source.length) {
    const skipped = skipUnexecuted(source, index);
    if (skipped !== null) {
      index = skipped;
      continue;
    }
    const character = source[index];
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      depth = Math.max(0, depth - 1);
    }
    index += 1;
  }
  return depth;
}

/**
 * Typst's imports, which are the one construct in this language that leaves the machine.
 *
 * `#import "@preview/…"` makes the compiler fetch a tarball from `packages.typst.org`. There
 * is no switch in the compiler's arguments to turn the registry off, so the milestone's rule —
 * the compiler runs local, no network at compile time — has to be a guard in front of it
 * rather than a hope about the machine being offline or the cache being warm.
 *
 * The guard is an **allow-list of import targets**, not a list of spellings of `@preview`.
 * The milestone-8 audit drove the real compiler past the old regex three ways —
 * `#import "\u{40}preview/x:0.1.0"`, `#import "@pre" + "view/x:0.1.0"`, and a third namespace
 * the pattern never named — because a package spec is an ordinary Typst string and a string
 * has more spellings than a deny-list can hold. What is *legitimate* here is the short list:
 * the headers are compiled into the source itself (`typstPrelude`) and the only other file the
 * compiler can see is a picture's bytes, so **no import whose target is written as a string is
 * ever right in this app**. An import from a module value — `#import calc: *` — reaches
 * neither the network nor the disk, and is left alone.
 *
 * So the rule is: an `#import`/`#include` statement containing a string is refused, whatever
 * the string says. It is checked against the *bytes handed to the compiler* rather than
 * against the request, which is the other half of the same lesson.
 */
const IMPORT_KEYWORD = /(?:#|[{;]\s*)(import|include)\b/gu;

/**
 * Why this source may not be compiled, or `null` when it may.
 *
 * A sentence the researcher can act on, not a code: they typed the import, and the answer to
 * "why did my page stop rendering" has to be readable on the page it stopped rendering on.
 */
export function refuseNetworkImports(source: string): string | null {
  // Blank out what is never executed first, keeping every offset, so the search below can be
  // an ordinary scan over the rest. A string keeps its two quotes and loses its contents: the
  // quotes are the whole signal here — *that* a target is written as a string — and the
  // contents are exactly what cannot be trusted to spell themselves recognisably.
  const characters = source.split('');
  let index = 0;
  while (index < source.length) {
    const skipped = skipUnexecuted(source, index);
    if (skipped === null) {
      index += 1;
      continue;
    }
    const quoted = source[index] === '"';
    for (let blank = quoted ? index + 1 : index; blank < (quoted ? skipped - 1 : skipped); blank += 1) {
      if (characters[blank] !== '\n') characters[blank] = ' ';
    }
    index = skipped;
  }
  const scanned = characters.join('');

  IMPORT_KEYWORD.lastIndex = 0;
  let found = IMPORT_KEYWORD.exec(scanned);
  while (found !== null) {
    // The statement is the rest of its line: a Typst import ends at the newline unless the
    // expression is still open, and a target spelled across lines cannot start on the next one.
    const lineEnd = scanned.indexOf('\n', found.index);
    const statement = scanned.slice(found.index, lineEnd === -1 ? scanned.length : lineEnd);
    if (statement.includes('"')) {
      return `Typst imports of a file or a package are refused here: a package is fetched over the network, and a notebook compiles against nothing but its own two headers. Define what you need in a header instead.`;
    }
    found = IMPORT_KEYWORD.exec(scanned);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Headers (`S05`)
// ---------------------------------------------------------------------------

/**
 * What every compiled notebook opens with: the two headers, as themselves.
 *
 * Global first, local second, and that order is the whole point of having two: a later `#let`
 * shadows an earlier one, so a notebook can redefine a global command with its own without
 * editing anything anybody else's notebook reads. Second also means the local header can
 * *build on* the global one, which two sibling modules could not.
 *
 * The headers used to be mounted as two virtual files and pulled in with `#import "…": *`,
 * which was wrong in a way that could not be seen from the outside: a wildcard import brings
 * **bindings**, and a `#show`/`#set` rule written in a module applies inside that module only.
 * The milestone-8 audit measured it — a global header of `#show heading: it => [SHOW: #it.body]`
 * compiled, stored, and did nothing — while the guide told the researcher to put "a style for
 * a figure" there. So the header text is concatenated in front of the source, where a rule
 * applies to the document it was written for.
 *
 * The cost of concatenating is that the compiled source no longer begins at the body, so a
 * source offset in the file is not a source offset in the block. Nothing measures one: `P05`
 * places its caret inside a single block's own text (`sourceOffsetFor`), and every anchor in
 * this app is text evidence rather than an offset into a compilation. A header that silently
 * does nothing is the worse of the two.
 */
export function typstPrelude(headers: {
  readonly global: string;
  readonly local: string;
}): string {
  const parts = [headers.global, headers.local]
    .map((header) => header.replace(/\s+$/u, ''))
    .filter((header) => header !== '');
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n\n`;
}
