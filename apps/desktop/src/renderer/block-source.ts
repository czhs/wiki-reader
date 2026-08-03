/**
 * A source document, seen as blocks (criteria N11, S01, S04).
 *
 * Two surfaces are written this way: a journal day (`journal_entries.markdown`, always
 * markdown) and a notebook's page (`questions.body`, Typst since the switch). Both are **one
 * document**. Blocks are a view over it: parsed out of the source to be edited one at a time,
 * and serialized straight back. There is no second store, no block table, and nothing that can
 * drift from the document, which is what keeps both readable by everything else — search, the
 * librarian, a person with a text editor.
 *
 * Deliberately not Jupyter: no execution, no kernels, no outputs. A code block is a command
 * or a snippet someone jotted down, and it stays exactly the text they typed.
 *
 * Pure and line-based, so the segmentation rules — which are where the off-by-ones live — are
 * testable without a DOM.
 */

import {
  isTypstImageBlock,
  parseTypstImage,
  typstOpenDepth,
  withTypstImageWidth,
  type NotebookBodyFormat,
} from '@wr/document-model';

export type BlockType = 'text' | 'code' | 'image';

/**
 * Which language a surface's document is written in (`S04`).
 *
 * The journal's day is markdown and a notebook's page is Typst, and almost every rule below is
 * the same for both: blank lines separate blocks in either language, and a fence is ``` in
 * either. Exactly one rule differs — what a *figure* looks like — so the language is a
 * parameter here rather than a second copy of this file, and every place it is read is a place
 * where the two languages genuinely disagree.
 */
export type BlockLanguage = NotebookBodyFormat;

/** Is this chunk nothing but one figure? The one segmentation rule the two languages spell differently. */
const isImageBlock = (src: string, language: BlockLanguage): boolean =>
  language === 'typst' ? isTypstImageBlock(src) : IMAGE_ONLY.test(src);

export interface Block {
  readonly type: BlockType;
  /** The exact markdown for this block, fences included. */
  readonly src: string;
}

/**
 * A paragraph that is nothing but one image is a figure, not prose.
 *
 * The optional trailing `"…"` is markdown's own title slot, and it is where a figure the
 * researcher has resized by hand keeps its width (`P11`). It has to be tolerated *here* or a
 * resized figure would stop being an `image` block the moment it was resized — `classify` runs
 * on every keystroke, and a block that fell back to `text` would lose its handle and its
 * drawing in the same instant.
 */
const IMAGE_ONLY = /^!\[[^\]]*\]\([^\s)]+(?: +"[^"]*")?\)$/;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Is this chunk a Typst construct that has not closed yet?
 *
 * Blank lines separate blocks in both languages, and in markdown nothing but a fence spans
 * one. Typst has several things that do — `#figure(image(…),\n\n  caption: […])` is how
 * Typst's own documentation writes a figure, and `#table(…)`, a `#let` with a paragraph in it
 * and any `#{ … }` are the same shape — and the milestone-8 audit found each of them split
 * into two halves that are each compiled alone, so the researcher got two red error blocks and
 * no figure.
 *
 * Only a chunk that **starts with `#`** is asked. That is what makes this safe: a paragraph of
 * prose with one unbalanced `(` in it would otherwise swallow the rest of the page, and prose
 * cannot start with `#` because that is where Typst's code starts and `escapeTypstText`
 * escapes it. A construct that never closes runs to the end of the document, which is the same
 * answer an unterminated fence gets and for the same reason: content is never dropped to make
 * the parse tidy.
 */
const stillOpen = (chunk: readonly string[], language: BlockLanguage): boolean =>
  language === 'typst' &&
  (chunk[0] ?? '').startsWith('#') &&
  typstOpenDepth(chunk.join('\n')) > 0;

/**
 * Split markdown into blocks.
 *
 * 1. A fence opens a code block and runs to its closing fence. An unterminated fence runs to
 *    the end of the document — content is never dropped to make the parse tidy.
 * 2. Otherwise non-blank lines accumulate until a blank line, except that a Typst construct
 *    which has not closed keeps going (`stillOpen`). A chunk that is exactly one image is an
 *    `image` block; everything else is `text`.
 * 3. Blank lines separate blocks and are not blocks themselves.
 */
export function parseBlocks(markdown: string, language: BlockLanguage = 'markdown'): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const opener = FENCE.exec(line);
    if (opener !== null) {
      const marker = opener[1] ?? '```';
      const chunk: string[] = [line];
      index += 1;
      let closed = false;
      while (index < lines.length) {
        const next = lines[index];
        if (next === undefined) break;
        chunk.push(next);
        index += 1;
        // A closing fence is the same character, at least as long, and nothing else.
        if (next.trim().startsWith(marker.slice(0, 3)) && next.trim().replace(/[`~]/g, '') === '') {
          closed = true;
          break;
        }
      }
      // A fence that closes keeps every line between its own, blank ones included — they are
      // the command's own formatting. One that never closes ran to the end of the document,
      // and the document's trailing newline is not part of what was typed.
      while (!closed && chunk.length > 1 && (chunk[chunk.length - 1] ?? '').trim() === '') {
        chunk.pop();
      }
      blocks.push({ type: 'code', src: chunk.join('\n') });
      continue;
    }

    const chunk: string[] = [];
    while (index < lines.length) {
      const next = lines[index];
      if (next === undefined) break;
      if ((next.trim() === '' || FENCE.test(next)) && !stillOpen(chunk, language)) break;
      chunk.push(next);
      index += 1;
    }
    // A construct that ran to the end of the document may have taken the trailing blank lines
    // with it; they are the document's spacing, not the block's.
    while (chunk.length > 1 && (chunk[chunk.length - 1] ?? '').trim() === '') chunk.pop();
    const src = chunk.join('\n');
    blocks.push({ type: isImageBlock(src.trim(), language) ? 'image' : 'text', src });
  }

  return blocks;
}

/**
 * Put the document back together.
 *
 * Blocks are joined by a blank line, which is what separated them going in. A block that is
 * only whitespace is dropped: an inserted block nobody typed into is an intention, not
 * content, and writing it out would leave the day looking logged. A document with nothing in
 * it serializes to the empty string, which is how the journal deletes a day.
 */
export function serializeBlocks(blocks: readonly Block[]): string {
  const kept = blocks
    .map((block) => block.src.replace(/\s+$/, ''))
    .filter((src) => src.trim() !== '');
  return kept.length === 0 ? '' : `${kept.join('\n\n')}\n`;
}

/**
 * Move a block within the document (`P07`).
 *
 * The order of the blocks *is* the document — `serializeBlocks` joins them in the order it is
 * given — so rearranging the page is this and nothing else. Pure, because an off-by-one in a
 * splice is the whole of what a drag can get wrong, and that is worth a test without a DOM.
 * A move that goes nowhere, or that names a block that is not there, answers with the list it
 * was handed rather than throwing: a pointer can leave the window mid-drag.
 */
export function moveBlock<T>(blocks: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= blocks.length || from === to) return [...blocks];
  const next = [...blocks];
  const [held] = next.splice(from, 1);
  if (held === undefined) return [...blocks];
  next.splice(Math.max(0, Math.min(to, next.length)), 0, held);
  return next;
}

/** An image block, taken apart: what it points at, what it is called, and how wide it is. */
export interface BlockImage {
  readonly alt: string;
  /** Always an `rrfile://` id in practice — the only scheme this window can fetch bytes over. */
  readonly url: string;
  /** The width it was dragged to, in CSS pixels. `null` means it has never been resized. */
  readonly width: number | null;
  /** Whatever else was in the title slot, so a resize cannot eat a caption. */
  readonly title: string | null;
}

const IMAGE_PARTS = /^!\[([^\]]*)\]\(([^\s)]+)(?: +"([^"]*)")?\)$/;
/** A width, written the way a figure carries it: one word in the title slot. */
const WIDTH_WORD = /^w=(\d+)$/;

/**
 * Read an image block's parts, or `null` when the block is not exactly one image (`P11`).
 *
 * The width lives in the markdown title slot rather than in a table beside the document,
 * because the document is the authority here as it is everywhere else on this surface: a
 * figure resized in this app is still a figure of that width to anything else that reads the
 * file, and there is no second store to fall out of step. The slot is read as words so a
 * caption and a width can share it.
 */
export function parseImage(src: string): BlockImage | null {
  const parts = IMAGE_PARTS.exec(src.trim());
  if (parts === null) return null;
  const words = (parts[3] ?? '').split(/\s+/u).filter((word) => word !== '');
  let width: number | null = null;
  const rest: string[] = [];
  for (const word of words) {
    const found = WIDTH_WORD.exec(word);
    if (found === null) rest.push(word);
    else width = Number(found[1]);
  }
  return {
    alt: parts[1] ?? '',
    url: parts[2] ?? '',
    width,
    title: rest.length === 0 ? null : rest.join(' '),
  };
}

/**
 * The same image block, at a new width — `null` takes the width off again.
 *
 * Rewrites only the `w=` word, which is what keeps a caption someone typed into the title slot
 * through a drag of the corner.
 */
export function withImageWidth(src: string, width: number | null): string {
  const image = parseImage(src);
  if (image === null) return src;
  const words = [
    ...(image.title === null ? [] : [image.title]),
    ...(width === null ? [] : [`w=${String(Math.round(width))}`]),
  ];
  const slot = words.length === 0 ? '' : ` "${words.join(' ')}"`;
  return `![${image.alt}](${image.url}${slot})`;
}

/** What a block's source makes it, after an edit that may have changed its kind. */
export function classify(src: string, language: BlockLanguage = 'markdown'): BlockType {
  const parsed = parseBlocks(src, language);
  const first = parsed[0];
  if (parsed.length === 1 && first !== undefined) return first.type;
  return 'text';
}

/**
 * A figure's parts, in either language (`S06`, `P11`).
 *
 * The two spellings keep the same property, which is the point: the width lives in the source
 * and there is no second store, so a figure resized here is that width to anything else that
 * reads the file. Markdown had to smuggle it into the title slot; Typst has a real named
 * argument for it, which is better and is still the same rule.
 */
export function parseBlockImage(src: string, language: BlockLanguage): BlockImage | null {
  if (language !== 'typst') return parseImage(src);
  const image = parseTypstImage(src);
  return image === null
    ? null
    : { alt: image.alt, url: `rrfile://${image.fileId}`, width: image.width, title: null };
}

/** The same figure at a new width, in either language. */
export function withBlockImageWidth(
  src: string,
  width: number | null,
  language: BlockLanguage,
): string {
  return language === 'typst' ? withTypstImageWidth(src, width) : withImageWidth(src, width);
}

/** The language on a code block's opening fence, or null when it carries none. */
export function codeLanguage(src: string): string | null {
  const first = src.split('\n')[0]?.trim() ?? '';
  const info = first.replace(/^[`~]+/, '').trim();
  return info === '' ? null : info;
}

/** A code block's text, without its fences — what a command actually is. */
export function codeBody(src: string): string {
  const lines = src.split('\n');
  const body = FENCE.test(lines[0] ?? '') ? lines.slice(1) : lines;
  const last = body[body.length - 1]?.trim() ?? '';
  if (last !== '' && last.replace(/[`~]/g, '') === '') body.pop();
  return body.join('\n').replace(/\s+$/, '');
}

/** The skeleton `+ code` inserts: an empty fenced block, waiting to be typed into. */
export const EMPTY_CODE_BLOCK = '```\n\n```';

/**
 * Reconcile an unsaved edit with a change that arrived from the main process.
 *
 * A picture is dropped by the preload and written into the document by the main process, so
 * the editor learns about it as a *new document* while the researcher may be halfway through
 * a block. Taking the new document wholesale threw the unsaved paragraph away — the
 * milestone-5 audit recorded it — and ignoring it would drop the picture.
 *
 * The one change that reaches a document this way is an **append**, so that is the case this
 * merges: when the arriving document still begins with the one the editor started from, the
 * tail is what was added and it is put after what the researcher has typed. Anything else is
 * an edit this side cannot reconcile, and the arriving document wins — losing an unsaved
 * block is bad, but silently discarding a write made elsewhere is worse.
 */
export function mergeAppend(baseline: string, mine: string, theirs: string): string {
  if (mine === baseline) return theirs;
  if (!theirs.startsWith(baseline)) return theirs;
  const appended = theirs.slice(baseline.length);
  if (appended.trim() === '') return mine;
  const head = mine.replace(/\s+$/, '');
  return head === '' ? appended.replace(/^\s+/, '') : `${head}\n\n${appended.replace(/^\s+/, '')}`;
}

/** Whitespace is whitespace: markdown renders a newline as a space, and a click on either
 *  means the same place. Compared this way so the alignment below does not walk past a line
 *  break hunting for a literal space. */
const isSpace = (character: string): boolean => /\s/u.test(character);

/**
 * Where a click in the *rendered* block lands in the block's **markdown source** (`P05`).
 *
 * A block is read as rendered markdown and edited as source, so a caret has to cross between
 * them. The rendered text is the source with its markup taken out — `## `, `**`, the `](url)`
 * half of a link, a fence — which makes it a subsequence: every visible character is in the
 * source, in order, with markup in between. So the offsets are aligned by walking both and
 * consuming one source character per rendered character, skipping whatever the renderer did
 * not show.
 *
 * A heuristic, deliberately. The exact answer needs a source map out of the markdown parser,
 * and the failure mode of this one is landing a few characters off inside the same word — the
 * failure mode of not doing it is landing at the start of the box every single time, which is
 * what `P05` is about.
 */
export function sourceOffsetFor(src: string, rendered: string, renderedOffset: number): number {
  const wanted = Math.max(0, Math.min(rendered.length, renderedOffset));
  let at = 0;
  /** Walk the source forward to the next character the reader can actually see. */
  const skipTo = (character: string): void => {
    while (at < src.length) {
      const candidate = src[at] ?? '';
      if (candidate === character || (isSpace(candidate) && isSpace(character))) return;
      at += 1;
    }
  };
  for (let index = 0; index < wanted; index += 1) {
    const character = rendered[index];
    if (character === undefined) break;
    skipTo(character);
    if (at < src.length) at += 1;
  }
  // Land *on* the next visible character rather than on the markup in front of it. Without
  // this a click at the start of a heading puts the caret before its `##`, where typing
  // makes the heading stop being one.
  const next = rendered[wanted];
  if (next !== undefined) skipTo(next);
  return Math.min(at, src.length);
}
