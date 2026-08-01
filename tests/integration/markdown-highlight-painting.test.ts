/**
 * @vitest-environment jsdom
 *
 * Where a highlight is actually painted on a rendered markdown page.
 *
 * A wiki page is mostly `[[wikilinks]]`, and a sentence worth marking usually contains one —
 * so "the highlight is in the sidebar but the page shows nothing" was the ordinary case, not
 * an edge one. The renderer used to look for the quote inside a single run of plain text,
 * which a chip, a bold word or a hard-wrapped line all break.
 *
 * What is asserted here is the painting, not the anchoring: the quotes below are exactly what
 * `normalizeText` produces for those sentences, which is what an anchor stores.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// By path, like the other renderer suites: the package entrypoint is built for the renderer
// bundle, and the render function's source is what is under test.
import { renderMarkdown } from '../../packages/markdown-reader/src/render.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function paint(source: string, quote: string, id = 'ann_1'): void {
  act(() => {
    root.render(
      createElement(
        'div',
        null,
        renderMarkdown(source, {
          highlights: [{ id, text: quote, color: 'ochre', selected: false }],
        }),
      ),
    );
  });
}

/** Everything the marks for one highlight cover, in document order. */
function marked(id = 'ann_1'): string {
  return [...container.querySelectorAll(`[data-testid="markdown-highlight-${id}"]`)]
    .map((mark) => mark.textContent ?? '')
    .join('');
}

describe('painting a highlight on a markdown page', () => {
  it('marks a plain sentence as one run', () => {
    paint(
      '# Spaced repetition\n\nRecall is strongest when review is spread out.\n',
      'Recall is strongest when review is spread out.',
    );
    expect(container.querySelectorAll('[data-annotation-id="ann_1"]')).toHaveLength(1);
    expect(marked()).toBe('Recall is strongest when review is spread out.');
  });

  it('carries a mark across a wikilink chip', () => {
    paint(
      'Intervals grow after each recall. See [[forgetting-curve]] for the shape.\n',
      'Intervals grow after each recall. See forgetting-curve for the shape.',
    );
    // Three pieces — before the chip, the chip, after it — and together they are the sentence.
    expect(marked()).toBe('Intervals grow after each recall. See forgetting-curve for the shape.');
    // The chip is still a chip: wrapped by the mark, not replaced by its own text.
    const chip = container.querySelector('[data-testid="wikilink-forgetting-curve"]');
    expect(chip).not.toBeNull();
    expect(chip?.closest('[data-annotation-id="ann_1"]')).not.toBeNull();
  });

  it('carries a mark across a hard-wrapped line', () => {
    paint(
      'Intervals grow after each successful recall, and the interval\nis what matters.\n',
      'Intervals grow after each successful recall, and the interval is what matters.',
    );
    // The rendered text is what the anchor quoted; the source newline is not in the quote.
    expect(marked().replace(/\s+/g, ' ')).toBe(
      'Intervals grow after each successful recall, and the interval is what matters.',
    );
  });

  it('carries a mark across emphasis and inline code', () => {
    paint(
      'The **spacing effect** is fitted in `schedule.py` for each learner.\n',
      'The spacing effect is fitted in schedule.py for each learner.',
    );
    expect(marked().replace(/\s+/g, ' ')).toBe(
      'The spacing effect is fitted in schedule.py for each learner.',
    );
    expect(container.querySelector('strong')?.closest('mark')).not.toBeNull();
    expect(container.querySelector('code')?.closest('mark')).not.toBeNull();
  });

  it('marks a quote whose punctuation was folded when it was stored', () => {
    // The file has a curly apostrophe and an em dash; the anchor stored the folded form.
    paint(
      'The learner’s schedule — not the total — is what matters.\n',
      "The learner's schedule - not the total - is what matters.",
    );
    expect(marked()).toBe('The learner’s schedule — not the total — is what matters.');
  });

  it('leaves a page with no highlights untouched', () => {
    act(() => {
      root.render(createElement('div', null, renderMarkdown('Nothing marked here.\n')));
    });
    expect(container.querySelectorAll('mark')).toHaveLength(0);
    expect(container.textContent).toContain('Nothing marked here.');
  });
});
