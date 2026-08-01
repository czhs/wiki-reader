/**
 * @vitest-environment jsdom
 *
 * LaTeX in a markdown block (`S02`), and the excerpt link that carries a quote back to what it
 * was cut from (`S03`).
 *
 * Both are properties of the one renderer the journal, the notebook page and the wiki all use,
 * so they are asserted here rather than three times over. What matters and is easy to lose:
 *
 * - a formula becomes **MathML elements**, not an HTML string and not a `<span>` full of text;
 * - a formula that does not parse comes back as the source the researcher typed;
 * - `$` in prose is money, not the start of an equation;
 * - a highlight painted over a sentence containing a formula does not cut into it;
 * - an `annotation://` link is a control that goes somewhere, which `safeHref` alone would
 *   have made an inert `<a href="#">`.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// By path, like the other renderer suites: the package entrypoint is built for the renderer
// bundle, and the render function's source is what is under test.
import { renderMarkdown } from '../../packages/markdown-reader/src/render.js';
import { MarkdownReaderView } from '../../packages/markdown-reader/src/MarkdownReaderView.js';
import { normalizeText, parseMarkdown } from '../../packages/document-model/src/index.js';
import type { InternalLink, MarkdownReaderSelection } from '../../packages/shared-types/src/index.js';

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

function draw(source: string, options: Parameters<typeof renderMarkdown>[1] = {}): void {
  act(() => {
    root.render(createElement('div', null, renderMarkdown(source, options)));
  });
}

const formulas = (): Element[] => [...container.querySelectorAll('[data-testid="markdown-math"]')];

describe('LaTeX in a block', () => {
  it('renders an inline formula as MathML, in the sentence it was written in', () => {
    draw('The loss is $E = mc^2$ at convergence.\n');
    const [math] = formulas();
    expect(math).toBeDefined();
    expect(math?.getAttribute('data-display')).toBe('inline');
    // MathML elements, built by React from the parsed tree — never innerHTML.
    expect(math?.querySelector('math')).not.toBeNull();
    expect(math?.querySelectorAll('mi').length).toBeGreaterThan(0);
    // And it is still inside the paragraph, not lifted out of it.
    expect(container.querySelector('p')?.textContent).toContain('The loss is');
    expect(container.querySelector('p')?.textContent).toContain('at convergence.');
  });

  it('renders a display formula as a block, marked as one', () => {
    draw('$$\\sum_{i=1}^{n} x_i$$\n');
    const [math] = formulas();
    expect(math).toBeDefined();
    expect(math?.getAttribute('data-display')).toBe('block');
    expect(math?.querySelector('math')?.getAttribute('display')).toBe('block');
  });

  it('draws both kinds in one document', () => {
    draw('Given $x$, the sum is\n\n$$\\int_0^1 f(x)\\,dx$$\n');
    expect(formulas().map((math) => math.getAttribute('data-display'))).toEqual([
      'inline',
      'block',
    ]);
  });

  it('gives back the source when the formula does not parse', () => {
    draw('This is $\\frac{1}{$ broken.\n');
    // Not swallowed and not thrown: what was typed, marked as unrendered.
    const error = container.querySelector('[data-testid="markdown-math-error"]');
    expect(error?.textContent).toBe('$\\frac{1}{$');
    expect(formulas()).toHaveLength(0);
  });

  it('leaves money alone', () => {
    draw('The GPUs cost $40 and the storage cost $12 a month.\n');
    expect(formulas()).toHaveLength(0);
    expect(container.textContent).toContain('$40');
    expect(container.textContent).toContain('$12');
  });

  it('leaves a dollar sign inside a code fence alone', () => {
    draw('```bash\necho $HOME and $PATH\n```\n');
    expect(formulas()).toHaveLength(0);
    expect(container.querySelector('pre code')?.textContent).toBe('echo $HOME and $PATH');
  });

  /**
   * The quote comes from the document's own projection rather than being written out here.
   *
   * That is the whole point of the case. An anchor's quote is `normalizeText` of what
   * `parseMarkdown` projects, and nothing in this application can mint one of any other shape
   * — so a test that spells the quote by hand is free to spell it the way the renderer
   * happens to want it. It did: `projectText` kept the `$` delimiters while the renderer's
   * atom for a formula is the TeX without them, so every real highlight over a sentence
   * containing mathematics stopped painting, and the test that was meant to cover this
   * passed on the one input for which the code worked.
   */
  it('[S02] paints a highlight whose quote is the one an anchor of the sentence would carry', () => {
    const source = 'Retention decays as $R = e^{-t/S}$ over time.\n';
    const quote = normalizeText(parseMarkdown(source).text);
    expect(quote, 'the projection is not the sentence').toBe(
      'Retention decays as R = e^{-t/S} over time.',
    );

    draw(source, { highlights: [{ id: 'ann_1', text: quote, color: 'ochre', selected: false }] });
    const marks = [...container.querySelectorAll('[data-annotation-id="ann_1"]')];
    expect(marks.length, 'the sentence was not painted at all').toBeGreaterThan(0);
    expect(marks.map((mark) => mark.textContent ?? '').join('')).toContain('Retention decays as');
    expect(marks.map((mark) => mark.textContent ?? '').join('')).toContain('over time.');

    // The formula is wrapped whole by a mark; no <mark> was opened inside the MathML.
    const math = formulas()[0];
    expect(math).toBeDefined();
    expect(math?.querySelector('mark')).toBeNull();
    expect(math?.closest('mark')).not.toBeNull();
  });

  it('[S02] projects a display formula the way it projects an inline one', () => {
    const projected = normalizeText(parseMarkdown('The schedule solves\n\n$$\\max_x f(x)$$\n').text);
    expect(projected).toBe('The schedule solves \\max_x f(x)');
  });

  it('[S02] still paints when the sentence carries a wikilink as well as a formula', () => {
    const source = 'See [[Forgetting curve|the curve]] where $t$ is the gap.\n';
    const quote = normalizeText(parseMarkdown(source).text);
    expect(quote).toBe('See the curve where t is the gap.');
    draw(source, { highlights: [{ id: 'ann_2', text: quote, color: 'ochre', selected: false }] });
    expect(container.querySelectorAll('[data-annotation-id="ann_2"]').length).toBeGreaterThan(0);
  });
});

/**
 * The other half of the same symmetry, driven through the reader rather than the renderer.
 *
 * Painting is what happens to a highlight that already exists; this is what happens when the
 * researcher tries to make one. `captureSelection` locates the drag in the document's own
 * projection, because the file — not this rendering of it — is what the anchor has to
 * survive. A formula is drawn as MathML and projected as TeX, so the selection has to be read
 * back in the spelling the document uses or `indexOf` answers -1, `onSelection(null)` fires,
 * and `SelectionBar` never appears: the Highlight button is simply absent, with no error and
 * no message.
 */
describe('selecting a sentence that contains a formula', () => {
  const SOURCE = 'Retention decays as $R = e^{-t/S}$ over time.\n';

  async function openReader(source: string): Promise<MarkdownReaderSelection | null | undefined> {
    let captured: MarkdownReaderSelection | null | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(source, { status: 200 })) as typeof globalThis.fetch;
    try {
      await act(async () => {
        root.render(
          createElement(MarkdownReaderView, {
            documentId: 'doc_1',
            fileUrl: 'rrfile://file_1',
            annotations: [],
            onSelection: (selection) => {
              captured = selection;
            },
          }),
        );
        await Promise.resolve();
      });

      const paragraph = container.querySelector('p');
      expect(paragraph, 'the reader did not render the file').not.toBeNull();
      act(() => {
        const range = document.createRange();
        range.selectNodeContents(paragraph as Element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        container
          .querySelector('[data-testid="markdown-scroll"]')
          ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
      return captured;
    } finally {
      globalThis.fetch = original;
    }
  }

  it('[S02] offers the selection, spelled the way the document spells the formula', async () => {
    const selection = await openReader(SOURCE);
    expect(selection, 'the reader refused a selection over a formula').not.toBeNull();
    expect(selection?.text).toBe('Retention decays as R = e^{-t/S} over time.');
    // And it is locatable in the document, which is what the anchor's offsets are cut from.
    expect(selection?.documentText.indexOf(selection.text)).toBe(selection?.position.start);
    expect(selection?.position.end).toBe(
      (selection?.position.start ?? 0) + (selection?.text.length ?? 0),
    );
  });

  it('[S02] reads a formula that did not parse the same way', async () => {
    const selection = await openReader('This is $\\frac{1}{$ broken.\n');
    expect(selection).not.toBeNull();
    expect(selection?.text).toBe('This is \\frac{1}{ broken.');
  });

  it('[S02] leaves a selection with no formula in it to the browser', async () => {
    const selection = await openReader('Retention decays roughly exponentially.\n');
    expect(selection?.text).toBe('Retention decays roughly exponentially.');
  });
});

describe('an excerpt keeps its link to the source', () => {
  const EXCERPT =
    '> Recall is strongest when review is spread out.\n>\n> — [Spacing effects](annotation://ann_01j5abcdefghjkmnpqrstvwxyz)\n';

  it('renders the attribution as a control that activates the annotation', () => {
    const activated: InternalLink[] = [];
    draw(EXCERPT, { internalLinks: { activate: (link) => activated.push(link) } });

    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid="internal-link-ann_01j5abcdefghjkmnpqrstvwxyz"]',
    );
    expect(chip).not.toBeNull();
    expect(chip?.tagName).toBe('BUTTON');
    expect(chip?.getAttribute('data-scheme')).toBe('annotation');
    expect(chip?.textContent).toBe('Spacing effects');

    act(() => {
      chip?.click();
    });
    expect(activated).toEqual([{ scheme: 'annotation', annotationId: 'ann_01j5abcdefghjkmnpqrstvwxyz' }]);

    // And the quote is still a quote, so the block reads as an excerpt in any markdown viewer.
    expect(container.querySelector('blockquote')?.textContent).toContain(
      'Recall is strongest when review is spread out.',
    );
  });

  it('draws the chip disabled rather than dead when nothing can navigate', () => {
    draw(EXCERPT);
    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid="internal-link-ann_01j5abcdefghjkmnpqrstvwxyz"]',
    );
    expect(chip?.disabled).toBe(true);
    // The failure this replaces: an <a href="#"> that looks live and goes nowhere.
    expect(container.querySelector('blockquote a')).toBeNull();
  });

  it('leaves an ordinary link an anchor', () => {
    draw('See [the paper](https://example.org/paper).\n');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.org/paper');
    expect(container.querySelector('[data-scheme]')).toBeNull();
  });
});
