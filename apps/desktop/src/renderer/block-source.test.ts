/**
 * A day's entry as blocks, and the markdown it is a view of (criterion N11).
 *
 * The load-bearing property is the round trip: parse, serialize, parse again, and the
 * document is the same. It is what makes "blocks are a view over one markdown document" true
 * rather than aspirational — a parser that silently drops an unterminated fence, or a
 * serializer that loses the blank line between two paragraphs, turns editing one block into
 * an edit of the whole day.
 */
import { describe, expect, it } from 'vitest';
import {
  classify,
  codeBody,
  codeLanguage,
  moveBlock,
  parseBlocks,
  parseImage,
  serializeBlocks,
  sourceOffsetFor,
  withImageWidth,
  type Block,
  mergeAppend,
} from './block-source.js';

/** A compact reading of a parse: `text:…`, `code:…`, `image:…`. */
function sketch(blocks: readonly Block[]): string[] {
  return blocks.map((block) => `${block.type}:${block.src.split('\n')[0] ?? ''}`);
}

const DAY = [
  '## Induction heads',
  '',
  'Layer 14 head 3 attends to the previous occurrence, then copies. Two more to check.',
  '',
  '```bash',
  'python sweep.py --layers 12-16 --heads all',
  '```',
  '',
  '![Attention pattern](rrfile://file_01H8XK4A)',
  '',
  'Next: the same sweep on the VLA checkpoints.',
  '',
].join('\n');

describe('a day as blocks', () => {
  it('[N11] splits a day into text, code and image blocks', () => {
    expect(sketch(parseBlocks(DAY))).toEqual([
      'text:## Induction heads',
      'text:Layer 14 head 3 attends to the previous occurrence, then copies. Two more to check.',
      'code:```bash',
      'image:![Attention pattern](rrfile://file_01H8XK4A)',
      'text:Next: the same sweep on the VLA checkpoints.',
    ]);

    // The code block keeps its fences verbatim: it is edited as source, so what is parsed out
    // has to be what goes back in.
    const code = parseBlocks(DAY)[2];
    expect(code?.src).toBe('```bash\npython sweep.py --layers 12-16 --heads all\n```');
    expect(codeLanguage(code?.src ?? '')).toBe('bash');
    expect(codeBody(code?.src ?? '')).toBe('python sweep.py --layers 12-16 --heads all');
  });

  it('[N11] round-trips: the document survives being seen as blocks', () => {
    const once = serializeBlocks(parseBlocks(DAY));
    const twice = serializeBlocks(parseBlocks(once));
    expect(twice).toBe(once);
    // And the day's content is all still in it, in order.
    expect(once).toContain('## Induction heads');
    expect(once).toContain('python sweep.py --layers 12-16 --heads all');
    expect(once).toContain('![Attention pattern](rrfile://file_01H8XK4A)');
    expect(once.trimEnd().endsWith('Next: the same sweep on the VLA checkpoints.')).toBe(true);
  });

  it('[N11] keeps a multi-line paragraph together and a blank line between blocks', () => {
    const blocks = parseBlocks('one\ntwo\n\nthree\n');
    expect(blocks.map((block) => block.src)).toEqual(['one\ntwo', 'three']);
    expect(serializeBlocks(blocks)).toBe('one\ntwo\n\nthree\n');
  });

  it('[N11] never loses an unterminated fence', () => {
    // A fence someone is still typing into. Ending the block at end-of-input keeps every
    // character; treating the rest of the day as prose would reformat it on the next write.
    const blocks = parseBlocks('```python\nx = 1\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('code');
    expect(blocks[0]?.src).toBe('```python\nx = 1');
  });

  it('[N11] a fence that follows a paragraph without a blank line is still a code block', () => {
    expect(sketch(parseBlocks('run it:\n```\nls\n```'))).toEqual(['text:run it:', 'code:```']);
  });

  it('[N11] an image with a caption beside it is prose, not a figure', () => {
    // Only a paragraph that is *nothing but* the image is a figure. A paragraph that also
    // says something is a paragraph, and rendering it as a bare image would drop the words.
    expect(sketch(parseBlocks('![a](rrfile://f1)\nthe residual stream'))).toEqual([
      'text:![a](rrfile://f1)',
    ]);
    expect(sketch(parseBlocks('![a](rrfile://f1)'))).toEqual(['image:![a](rrfile://f1)']);
  });

  it('[N11] an empty day has no blocks, and blocks nobody typed into write nothing', () => {
    expect(parseBlocks('')).toEqual([]);
    expect(parseBlocks('\n\n  \n')).toEqual([]);
    // This is what deletes a day: the journal treats blank markdown as "no entry", so a page
    // whose blocks are all empty must serialize to nothing rather than to whitespace.
    expect(serializeBlocks([])).toBe('');
    expect(serializeBlocks([{ type: 'text', src: '   ' }])).toBe('');
    expect(serializeBlocks([{ type: 'text', src: '' }, { type: 'text', src: 'kept' }])).toBe(
      'kept\n',
    );
  });

  it('[N11] a block edited into a fence becomes a code block', () => {
    // The type follows the source, so typing a fence into a text block turns it into one
    // rather than leaving a code block rendered as prose until the page is reloaded.
    expect(classify('just words')).toBe('text');
    expect(classify('```sh\nls\n```')).toBe('code');
    expect(classify('![a](rrfile://f1)')).toBe('image');
    // Two blocks' worth of text pasted into one editor stays editable as text; it splits on
    // the next parse rather than being mislabelled now.
    expect(classify('one\n\ntwo')).toBe('text');
  });

  it('[P05] a click in the rendered block maps back into the markdown source', () => {
    // The plain case: nothing was taken out on the way to the screen, so the offsets agree.
    expect(sourceOffsetFor('alpha bravo charlie', 'alpha bravo charlie', 12)).toBe(12);

    // A heading renders without its `## `, so the same word is three characters further on
    // in the source than it is on the screen. Landing at the rendered offset would put the
    // caret three characters early — inside the word before, on a short line.
    const heading = '## Induction heads';
    expect(sourceOffsetFor(heading, 'Induction heads', 0)).toBe(3);
    expect(sourceOffsetFor(heading, 'Induction heads', 10)).toBe(13);

    // Emphasis and links are markup the renderer swallowed; the visible text is still a
    // subsequence of the source, which is what the alignment walks.
    const emphasised = 'the **copying** circuit';
    expect(sourceOffsetFor(emphasised, 'the copying circuit', 4)).toBe(6);
    const linked = 'see [the sweep](rrfile://f1) again';
    expect(sourceOffsetFor(linked, 'see the sweep again', 4)).toBe(5);

    // A newline in the source is a space on screen: a click after the line break belongs
    // after the break, not wherever the next literal space happens to be.
    expect(sourceOffsetFor('first line\nsecond line', 'first line second line', 11)).toBe(11);

    // Bounds are clamped rather than trusted: a click past the end of a block is the end of
    // it, and a negative offset is the start.
    expect(sourceOffsetFor('short', 'short', 99)).toBe(5);
    expect(sourceOffsetFor('short', 'short', -3)).toBe(0);
  });
});

/**
 * Rearranging the page (`P07`).
 *
 * The document *is* the order of its blocks, so the whole of a reorder is this splice and the
 * write that follows it. Tested without a DOM because an off-by-one in a splice is the entire
 * failure mode of a drag, and a Playwright run is a very slow place to find one.
 */
describe('moving a block', () => {
  const page: Block[] = [
    { type: 'text', src: 'one' },
    { type: 'text', src: 'two' },
    { type: 'text', src: 'three' },
  ];

  it('[P07] a moved block changes the document, because the order is the document', () => {
    expect(serializeBlocks(moveBlock(page, 2, 0))).toBe('three\n\none\n\ntwo\n');
    expect(serializeBlocks(moveBlock(page, 0, 2))).toBe('two\n\nthree\n\none\n');
    expect(serializeBlocks(moveBlock(page, 1, 0))).toBe('two\n\none\n\nthree\n');
  });

  it('[P07] nothing is lost, whatever the drag did', () => {
    // A move that goes nowhere, a move off either end, a move of a block that is not there:
    // all of them answer with a page holding the same three blocks. A pointer can leave the
    // window mid-drag, and a drag that throws would leave the page half-written.
    for (const [from, to] of [
      [1, 1],
      [0, 99],
      [2, -4],
      [7, 0],
      [-1, 1],
    ] as const) {
      const moved = moveBlock(page, from, to);
      expect(moved).toHaveLength(3);
      expect([...moved].map((block) => block.src).sort()).toEqual(['one', 'three', 'two']);
    }
    // And the input is never mutated: the editor holds the rows it is rendering.
    expect(page.map((block) => block.src)).toEqual(['one', 'two', 'three']);
  });
});

/**
 * A figure's width, which lives in the markdown and nowhere else (`P11`).
 *
 * The trap this guards is the one that would make the feature silently useless: `classify`
 * runs on every keystroke, and a resized image whose source no longer looked like a lone image
 * would become a `text` block — losing its handle, its drawing and its width in one go.
 */
describe('a figure that has been resized by hand', () => {
  it('[P11] a width in the title slot is still a figure, not prose', () => {
    expect(classify('![a](rrfile://f1 "w=320")')).toBe('image');
    expect(sketch(parseBlocks('![a](rrfile://f1 "w=320")'))).toEqual([
      'image:![a](rrfile://f1 "w=320")',
    ]);
    // And the rule that made it a figure in the first place still holds: a paragraph that says
    // something as well as showing something is prose.
    expect(classify('![a](rrfile://f1 "w=320")\nthe residual stream')).toBe('text');
  });

  it('[P11] reads back what the drag wrote, and nothing it did not', () => {
    expect(parseImage('![Attention](rrfile://dfl_1)')).toEqual({
      alt: 'Attention',
      url: 'rrfile://dfl_1',
      width: null,
      title: null,
    });
    expect(parseImage('![Attention](rrfile://dfl_1 "w=280")')).toEqual({
      alt: 'Attention',
      url: 'rrfile://dfl_1',
      width: 280,
      title: null,
    });
    // A caption and a width share the slot, so resizing a figure someone titled does not take
    // the title away.
    expect(parseImage('![a](rrfile://dfl_1 "Figure 2 w=280")')).toEqual({
      alt: 'a',
      url: 'rrfile://dfl_1',
      width: 280,
      title: 'Figure 2',
    });
    expect(parseImage('not a picture at all')).toBeNull();
  });

  it('[P11] writing a width round-trips, and clearing it leaves the figure alone', () => {
    const plain = '![Attention](rrfile://dfl_1)';
    const wide = withImageWidth(plain, 420);
    expect(wide).toBe('![Attention](rrfile://dfl_1 "w=420")');
    expect(parseImage(wide)?.width).toBe(420);
    // Re-dragging replaces the width rather than accumulating them.
    expect(withImageWidth(wide, 96)).toBe('![Attention](rrfile://dfl_1 "w=96")');
    // Fractional pixels come off a bounding box; the document keeps a whole number.
    expect(withImageWidth(plain, 199.6)).toBe('![Attention](rrfile://dfl_1 "w=200")');
    // Cleared, it is the markdown it started as — no empty title slot left behind.
    expect(withImageWidth(wide, null)).toBe(plain);
    expect(withImageWidth('![a](rrfile://dfl_1 "Figure 2 w=280")', null)).toBe(
      '![a](rrfile://dfl_1 "Figure 2")',
    );
    // Not a figure: left exactly as it was, rather than half-rewritten.
    expect(withImageWidth('just words', 300)).toBe('just words');
  });
});

/**
 * The picture-drop bug the milestone-5 audit recorded: a figure written into the document by
 * the main process while a block was open used to take the unsaved text with it.
 */
describe('mergeAppend', () => {
  const BASE = '## Sweep\n\nRan the sweep.\n';

  it('takes the arriving document when nothing was unsaved', () => {
    expect(mergeAppend(BASE, BASE, `${BASE}\n![fig](rrfile://dfl_1)\n`)).toBe(
      `${BASE}\n![fig](rrfile://dfl_1)\n`,
    );
  });

  it('keeps the unsaved block and the picture that arrived under it', () => {
    const mine = `${BASE}\nA paragraph nobody has saved yet.\n`;
    const merged = mergeAppend(BASE, mine, `${BASE}\n![fig](rrfile://dfl_1)\n`);
    expect(merged).toContain('A paragraph nobody has saved yet.');
    expect(merged).toContain('![fig](rrfile://dfl_1)');
    // And in that order: what was being written, then what arrived.
    expect(merged.indexOf('A paragraph')).toBeLessThan(merged.indexOf('![fig]'));
  });

  it('leaves the unsaved work alone when nothing but whitespace arrived', () => {
    const mine = `${BASE}\nStill typing.\n`;
    expect(mergeAppend(BASE, mine, `${BASE}\n\n`)).toBe(mine);
  });

  it('yields to a change it cannot reconcile rather than discarding it', () => {
    // Not an append: the document was rewritten elsewhere. Losing an unsaved block is bad;
    // silently dropping a write made somewhere else is worse.
    const theirs = '## Something else entirely\n';
    expect(mergeAppend(BASE, `${BASE}\nmine\n`, theirs)).toBe(theirs);
  });

  it('produces one document when the merge happens on an empty page', () => {
    expect(mergeAppend('', '', '![fig](rrfile://dfl_1)\n')).toBe('![fig](rrfile://dfl_1)\n');
    expect(mergeAppend('', 'typed', '![fig](rrfile://dfl_1)\n')).toBe(
      'typed\n\n![fig](rrfile://dfl_1)\n',
    );
  });
});
