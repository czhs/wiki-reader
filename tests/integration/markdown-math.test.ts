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
import type { InternalLink } from '../../packages/shared-types/src/index.js';

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

  it('paints a highlight around a formula rather than through it', () => {
    draw('Recall improves when $t$ grows.\n', {
      highlights: [
        { id: 'ann_1', text: 'Recall improves when t grows.', color: 'ochre', selected: false },
      ],
    });
    const marks = [...container.querySelectorAll('[data-annotation-id="ann_1"]')];
    expect(marks.length).toBeGreaterThan(0);
    // The formula is wrapped whole by a mark; no <mark> was opened inside the MathML.
    const math = formulas()[0];
    expect(math).toBeDefined();
    expect(math?.querySelector('mark')).toBeNull();
    expect(math?.closest('mark')).not.toBeNull();
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
