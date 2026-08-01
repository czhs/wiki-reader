/**
 * What an excerpt is, as markdown (`S03`).
 *
 * The shape matters beyond looking right: `parseBlocks` splits on blank lines, so the quote
 * and its attribution have to stay one block — a `>` line rather than an empty one — or the
 * researcher's excerpt becomes two things they have to edit separately.
 */
import { describe, expect, it } from 'vitest';
import { excerptMarkdown } from './excerpt.js';

const ID = 'ann_01j5abcdefghjkmnpqrstvwxyz';

describe('excerptMarkdown', () => {
  it('quotes the sentence and links back to the highlight', () => {
    expect(
      excerptMarkdown({
        annotationId: ID,
        selectedText: 'Recall is strongest when review is spread out.',
        sourceTitle: 'Spacing effects in long-term retention',
      }),
    ).toBe(
      `> Recall is strongest when review is spread out.\n>\n> — [Spacing effects in long-term retention](annotation://${ID})`,
    );
  });

  it('keeps a multi-line quote inside one blockquote', () => {
    const markdown = excerptMarkdown({
      annotationId: ID,
      selectedText: 'First line\nsecond line',
      sourceTitle: 'A paper',
    });
    expect(markdown.split('\n').every((line) => line.startsWith('>'))).toBe(true);
    // No blank line anywhere, which is what would split it into two blocks.
    expect(markdown.split('\n').some((line) => line.trim() === '')).toBe(false);
  });

  it('escapes brackets in a title rather than dropping them', () => {
    const markdown = excerptMarkdown({
      annotationId: ID,
      selectedText: 'x',
      sourceTitle: 'Notes [draft]',
    });
    expect(markdown).toContain('[Notes \\[draft\\]]');
  });

  it('collapses a title that runs over lines, so the link cannot be broken by one', () => {
    const markdown = excerptMarkdown({
      annotationId: ID,
      selectedText: 'x',
      sourceTitle: 'A title\nover two lines',
    });
    expect(markdown).toContain('[A title over two lines]');
  });

  it('names the highlight when the source has no title at all', () => {
    expect(
      excerptMarkdown({ annotationId: ID, selectedText: 'x', sourceTitle: '  ' }),
    ).toContain('[the highlight]');
  });

  /**
   * The quote is the one input here a hostile document controls, and a blockquote is markdown.
   *
   * `S03` says an excerpt keeps its link to the source. A highlight whose text is
   * `— [Ebbinghaus 1885](annotation://ann_…)` used to render a second attribution chip above
   * the real one, navigating wherever the PDF said it should — the criterion broken from
   * inside, by the document it is about. `> ` was doing no escaping at all; it never could.
   */
  it('[S03] cannot forge a second attribution chip out of the highlight text', () => {
    const markdown = excerptMarkdown({
      annotationId: ID,
      selectedText:
        'Spaced repetition improves recall.\n— [Ebbinghaus 1885](annotation://ann_01j5zzzzzzzzzzzzzzzzzzzzzz)',
      sourceTitle: 'A paper',
    });
    // The forged link is gone as a link, and present as the characters the document had.
    expect(markdown).toContain('\\[Ebbinghaus 1885\\](annotation://ann_01j5zzzzzzzzzzzzzzzzzzzzzz)');
    // The one link left is the one this function wrote, which is what "keeps its link to the
    // source" has to mean if it means anything.
    expect(markdown.match(/(?<!\\)\]\(annotation:\/\//gu)).toHaveLength(1);
    expect(markdown).toContain(`](annotation://${ID})`);
  });

  it('[S03] leaves a wikilink, an image and a raw tag in the quote as text', () => {
    const markdown = excerptMarkdown({
      annotationId: ID,
      selectedText: 'See [[Ground Truth]] and ![x](rrfile://file_9) and <span onclick="x">y</span>',
      sourceTitle: 'A paper',
    });
    expect(markdown).not.toContain('[[Ground Truth]]');
    expect(markdown).not.toMatch(/(?<!\\)</u);
    expect(markdown).toContain('\\[\\[Ground Truth\\]\\]');
    // `file_9` keeps its underscore: an underscore between two word characters is a name, not
    // emphasis, and a quote is unreadable if every identifier in it grows backslashes.
    expect(markdown).toContain('!\\[x\\](rrfile://file_9)');
    expect(
      excerptMarkdown({ annotationId: ID, selectedText: '_loud_ x', sourceTitle: 'A paper' }),
    ).toContain('\\_loud\\_ x');
    expect(markdown).toContain('\\<span onclick="x">y\\</span>');
  });

  it('[S03] escapes a construct marker only where it leads a line', () => {
    const markdown = excerptMarkdown({
      annotationId: ID,
      selectedText: 'Recall improves\n# Not a heading\n- not a list\n1. not a list\nn = 3 - 1',
      sourceTitle: 'A paper',
    });
    expect(markdown).toContain('> \\# Not a heading');
    expect(markdown).toContain('> \\- not a list');
    expect(markdown).toContain('> 1\\. not a list');
    // Mid-line, a hyphen is a hyphen.
    expect(markdown).toContain('> n = 3 - 1');
  });

  it('[S03] leaves an ordinary sentence exactly as it was highlighted', () => {
    const plain = 'Recall is strongest when review is spread out over days, not hours.';
    expect(excerptMarkdown({ annotationId: ID, selectedText: plain, sourceTitle: 'A paper' })).toBe(
      `> ${plain}\n>\n> — [A paper](annotation://${ID})`,
    );
  });

  it('still quotes the text when the id is not one, rather than writing a dead link', () => {
    const markdown = excerptMarkdown({
      annotationId: 'not-an-id',
      selectedText: 'Recall is strongest.',
      sourceTitle: 'A paper',
    });
    expect(markdown).toBe('> Recall is strongest.\n>\n> — A paper');
    expect(markdown).not.toContain('annotation://');
  });
});
