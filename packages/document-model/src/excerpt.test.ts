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
