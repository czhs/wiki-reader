/**
 * A day's entry, seen as blocks (criterion N11).
 *
 * The day is **one markdown document** — the row `journal_entries` already holds. Blocks are a
 * view over it: parsed out of the markdown to be edited one at a time, and serialized straight
 * back. There is no second store, no block table, and nothing that can drift from the
 * document, which is what keeps the journal readable by everything else that reads markdown —
 * search, the librarian, a person with a text editor.
 *
 * Deliberately not Jupyter: no execution, no kernels, no outputs. A code block is a command
 * or a snippet someone jotted down, and it stays exactly the text they typed.
 *
 * Pure and line-based, so the segmentation rules — which are where the off-by-ones live — are
 * testable without a DOM.
 */

export type BlockType = 'text' | 'code' | 'image';

export interface Block {
  readonly type: BlockType;
  /** The exact markdown for this block, fences included. */
  readonly src: string;
}

/** A paragraph that is nothing but one image is a figure, not prose. */
const IMAGE_ONLY = /^!\[[^\]]*\]\([^\s)]+\)$/;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Split markdown into blocks.
 *
 * 1. A fence opens a code block and runs to its closing fence. An unterminated fence runs to
 *    the end of the document — content is never dropped to make the parse tidy.
 * 2. Otherwise non-blank lines accumulate until a blank line. A chunk that is exactly one
 *    image is an `image` block; everything else is `text`.
 * 3. Blank lines separate blocks and are not blocks themselves.
 */
export function parseBlocks(markdown: string): Block[] {
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
      if (next === undefined || next.trim() === '' || FENCE.test(next)) break;
      chunk.push(next);
      index += 1;
    }
    const src = chunk.join('\n');
    blocks.push({ type: IMAGE_ONLY.test(src.trim()) ? 'image' : 'text', src });
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

/** What a block's source makes it, after an edit that may have changed its kind. */
export function classify(src: string): BlockType {
  const parsed = parseBlocks(src);
  const first = parsed[0];
  if (parsed.length === 1 && first !== undefined) return first.type;
  return 'text';
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
  for (let index = 0; index < wanted; index += 1) {
    const character = rendered[index];
    if (character === undefined) break;
    while (at < src.length) {
      const candidate = src[at] ?? '';
      if (candidate === character || (isSpace(candidate) && isSpace(character))) break;
      at += 1;
    }
    if (at < src.length) at += 1;
  }
  return Math.min(at, src.length);
}
