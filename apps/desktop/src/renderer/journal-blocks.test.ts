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
  parseBlocks,
  serializeBlocks,
  type Block,
} from './journal-blocks.js';

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
});
