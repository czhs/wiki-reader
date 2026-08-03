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
 * `\` is the escape itself, and `/`, `-`, `+`, `=` lead a list item or a heading — those four
 * only where they lead a line, which is the only place Typst reads them that way, so a sentence
 * with a hyphen in it still reads as the sentence.
 */
export function escapeTypstText(text: string): string {
  return text
    .replace(/([\\#$*_`@<>[\]])/gu, '\\$1')
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

/**
 * Typst's package imports, which are **not local**.
 *
 * `#import "@preview/…"` makes the compiler fetch a tarball from `packages.typst.org`. There
 * is no switch in the compiler's arguments to turn the registry off, so the milestone's rule —
 * the compiler runs local, no network at compile time — has to be a guard in front of it
 * rather than a hope about the machine being offline or the cache being warm.
 */
const NETWORK_IMPORT_RE = /(?:^|[^\p{L}\p{N}_])@(preview|local)\//mu;

/**
 * Why this source may not be compiled, or `null` when it may.
 *
 * A sentence the researcher can act on, not a code: they typed the import, and the answer to
 * "why did my page stop rendering" has to be readable on the page it stopped rendering on.
 */
export function refuseNetworkImports(source: string): string | null {
  const found = NETWORK_IMPORT_RE.exec(source);
  if (found === null) return null;
  return `Typst packages are fetched over the network, so @${found[1] ?? 'preview'}/ imports are refused here. Define what you need in a header instead.`;
}

// ---------------------------------------------------------------------------
// Headers (`S05`)
// ---------------------------------------------------------------------------

/** The virtual file the application-wide header is mounted as. */
export const TYPST_GLOBAL_HEADER_PATH = '/wr-global.typ';
/** The virtual file this notebook's own header is mounted as. */
export const TYPST_LOCAL_HEADER_PATH = '/wr-local.typ';

/**
 * The two lines every compiled notebook opens with.
 *
 * Global first, local second, and that order is the whole point of having two: a wildcard
 * import binds later definitions over earlier ones, so a notebook can shadow a global command
 * with its own without editing anything anybody else's notebook reads.
 *
 * A prelude of `#import` lines rather than the header text concatenated onto the body, because
 * concatenation shifts every source offset in the document by the header's length — and
 * offsets are what `P05`'s caret placement and every future anchor are made of. Two lines is a
 * known, fixed shift; a header somebody is editing is not.
 */
export function typstPrelude(): string {
  return `#import ${typstString(TYPST_GLOBAL_HEADER_PATH)}: *\n#import ${typstString(TYPST_LOCAL_HEADER_PATH)}: *\n`;
}
