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
 *
 * And the last describe is the security half: `math.tsx` is the milestone's one new parser of
 * untrusted input, sitting in the app's own origin, and until those cases existed nothing in
 * the tree could tell its rebuild-against-an-allowlist from `dangerouslySetInnerHTML`. Every
 * assertion there was watched to fail against both of the mutations it is there to catch.
 */
import { act, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// By path, like the other renderer suites: the package entrypoint is built for the renderer
// bundle, and the render function's source is what is under test.
import { renderMarkdown } from '../../packages/markdown-reader/src/render.js';
import {
  ALLOWED_ATTRIBUTES,
  ALLOWED_TAGS,
  MAX_USER_SIZE_EM,
  elementsFromMathML,
} from '../../packages/markdown-reader/src/math.js';
import { MarkdownReaderView } from '../../packages/markdown-reader/src/MarkdownReaderView.js';
import {
  excerptMarkdown,
  normalizeText,
  parseMarkdown,
} from '../../packages/document-model/src/index.js';
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

  /**
   * The excerpt is written by `excerptMarkdown` and rendered here, which is the only place the
   * two halves meet — and the quote is the one input in it a hostile document controls.
   *
   * A highlight whose own text spells an `annotation://` link used to render a second
   * attribution chip above the real one, navigating wherever the PDF said. The blockquote's
   * `> ` prefix was doing no escaping; it never could.
   */
  it('[S03] renders one attribution chip, even when the quote spells another', () => {
    const forged = 'ann_01j5zzzzzzzzzzzzzzzzzzzzzz';
    draw(
      excerptMarkdown({
        annotationId: 'ann_01j5abcdefghjkmnpqrstvwxyz',
        selectedText: `Recall improves.\n— [Ebbinghaus 1885](annotation://${forged}) and [out](https://evil.example/x)`,
        sourceTitle: 'Spacing effects',
      }),
      { internalLinks: { activate: () => undefined } },
    );

    const chips = [...container.querySelectorAll('[data-scheme]')];
    expect(chips.map((chip) => chip.getAttribute('data-target'))).toEqual([
      'ann_01j5abcdefghjkmnpqrstvwxyz',
    ]);
    expect(container.querySelector(`[data-testid="internal-link-${forged}"]`)).toBeNull();

    // The one anchor left is GFM autolinking a bare URL, which has no punctuation to escape.
    // It prints its own destination — never a label hiding one — and `will-navigate` refuses
    // every URL that is not this window's origin, so it is a URL on the page and nothing more.
    expect(
      [...container.querySelectorAll('blockquote a')].map((anchor) => [
        anchor.textContent,
        anchor.getAttribute('href'),
      ]),
    ).toEqual([['https://evil.example/x', 'https://evil.example/x']]);

    // The words the researcher marked are still the words on the page.
    const quoted = container.querySelector('blockquote')?.textContent ?? '';
    expect(quoted).toContain('— [Ebbinghaus 1885](annotation://ann_01j5zzzzzzzzzzzzzzzzzzzzzz)');
    expect(quoted).toContain('[out](https://evil.example/x)');
  });
});

/**
 * LaTeX is hostile input, and this is the only thing standing between it and the origin.
 *
 * A formula arrives from a corpus file, from a notes folder, or — since `S03` — quoted out of
 * a PDF onto the page the researcher writes their paper on. `math.tsx` answers it by parsing
 * KaTeX's output string with `DOMParser` and rebuilding it as React elements against two
 * allowlists, rather than by handing the string to `dangerouslySetInnerHTML`.
 *
 * That is the right answer and it was completely unguarded. Both of these passed every test
 * that existed:
 *
 * - swapping the body of `renderMath` for `dangerouslySetInnerHTML={{ __html: html }}` — the
 *   DOM still holds a `<math>` with `<mi>` children and the right `display`;
 * - adding `href`, `style` and `id` to `ALLOWED_ATTRIBUTES` — nothing renders differently,
 *   because `trust: false` means KaTeX never emits one.
 *
 * So the cases below assert the mechanism and not only its effect: the allowlists by their
 * contents, the rebuild driven directly with markup KaTeX would never produce, and the shape of
 * what `renderMarkdown` returns walked as a React tree. A comment is not an instrument.
 */
describe('the allowlist between hostile TeX and the page', () => {
  /** Every element in a `ReactNode`, depth first — the tree as returned, before any DOM. */
  function elementsOf(node: ReactNode): ReactElement[] {
    if (Array.isArray(node)) return node.flatMap((child) => elementsOf(child as ReactNode));
    if (!isValidElement(node)) return [];
    const props = node.props as { children?: ReactNode };
    return [node, ...elementsOf(props.children)];
  }

  const attributesUnderMath = (): { name: string; value: string }[] =>
    [...container.querySelectorAll('[data-testid="markdown-math"] *')].flatMap((element) =>
      [...element.attributes].map((attribute) => ({
        name: attribute.name.toLowerCase(),
        value: attribute.value,
      })),
    );

  it('[S02] names the MathML it will admit, and that list is the decision', () => {
    expect([...ALLOWED_TAGS].sort()).toEqual([
      'annotation',
      'maction',
      'math',
      'menclose',
      'merror',
      'mfrac',
      'mi',
      'mmultiscripts',
      'mn',
      'mo',
      'mover',
      'mpadded',
      'mphantom',
      'mprescripts',
      'mroot',
      'mrow',
      'ms',
      'mspace',
      'msqrt',
      'mstyle',
      'msub',
      'msubsup',
      'msup',
      'mtable',
      'mtd',
      'mtext',
      'mtr',
      'munder',
      'munderover',
      'none',
      'semantics',
    ]);
  });

  it('[S02] names the attributes it will admit, and none of them is behaviour', () => {
    expect([...ALLOWED_ATTRIBUTES].sort()).toEqual([
      'accent',
      'accentunder',
      'align',
      'close',
      'columnalign',
      'columnspacing',
      'depth',
      'dir',
      'display',
      'displaystyle',
      'encoding',
      'fence',
      'height',
      'largeop',
      'linethickness',
      'lspace',
      'mathvariant',
      'maxsize',
      'minsize',
      'movablelimits',
      'notation',
      'open',
      'rowalign',
      'rowspacing',
      'rspace',
      'scriptlevel',
      'separator',
      'separators',
      'stretchy',
      'symmetric',
      'voffset',
      'width',
    ]);
    // Spelled out because their absence is what the file is for, and because adding any one of
    // them changes nothing a rendering can observe.
    for (const forbidden of ['href', 'id', 'style', 'class', 'onclick', 'src', 'xlink:href']) {
      expect(ALLOWED_ATTRIBUTES.has(forbidden), `${forbidden} is admitted`).toBe(false);
    }
  });

  it('[S02] drops a tag it does not know, and the subtree under it', () => {
    act(() => {
      root.render(
        createElement(
          'div',
          null,
          elementsFromMathML(
            '<math><mrow><mi>kept</mi><script>evil()</script>' +
              '<mglyph src="rrfile://file_9"><mi>gone</mi></mglyph></mrow></math>',
            'k',
          ),
        ),
      );
    });
    expect(container.querySelector('math')).not.toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('mglyph')).toBeNull();
    expect(container.textContent).toContain('kept');
    // With its subtree: an allowed child of a refused parent does not survive its parent.
    expect(container.textContent).not.toContain('gone');
    expect(container.textContent).not.toContain('evil()');
  });

  it('[S02] drops an attribute it does not know from a tag it does', () => {
    act(() => {
      root.render(
        createElement(
          'div',
          null,
          elementsFromMathML(
            '<math><mi id="app-root" href="javascript:1" style="position:fixed" ' +
              'data-target="ann_1" mathvariant="bold">x</mi></math>',
            'k',
          ),
        ),
      );
    });
    const mi = container.querySelector('mi');
    expect(mi).not.toBeNull();
    expect(mi?.getAttribute('mathvariant')).toBe('bold');
    expect([...(mi?.attributes ?? [])].map((attribute) => attribute.name)).toEqual(['mathvariant']);
  });

  /**
   * `\href`, `\htmlId`, `\htmlClass`, `\htmlData`, `\htmlStyle` and `\includegraphics` are the
   * six commands that exist to put behaviour or a fetch into the output. `trust: false` refuses
   * each at the source; this asserts what reaches the page rather than trusting the option.
   */
  // The host is spelled without a scheme on purpose: GFM autolinks a bare `https://…` before
  // the inline pass ever sees it, which would split the `$…$` and test nothing.
  it.each([
    ['\\href{evil.example/x}{click}', '\\href'],
    ['\\htmlId{app-root}{x}', '\\htmlId'],
    ['\\htmlClass{wr-internal-link}{x}', '\\htmlClass'],
    ['\\htmlData{target=ann_1}{x}', '\\htmlData'],
    ['\\htmlStyle{position:fixed;inset:0}{x}', '\\htmlStyle'],
    ['\\includegraphics[height=1em]{evil.example/pixel.png}', '\\includegraphics'],
  ])('[S02] renders %s inert', (tex, shown) => {
    draw(`A $${tex}$ B\n`);
    const math = formulas()[0];
    expect(math, 'the formula did not render at all').toBeDefined();
    // The command arrives as the characters it is, which is KaTeX's own refusal showing.
    expect(math?.textContent).toContain(shown);
    // And nothing under it is a link, an anchor, or a hook for anything. The TeX itself is in
    // `data-tex` and in KaTeX's `<annotation>`, as text, which is what a copy-paste reads.
    expect(container.querySelector('[data-testid="markdown-math"] a')).toBeNull();
    expect(container.querySelector('[data-testid="markdown-math"] [src]')).toBeNull();
    const names = attributesUnderMath().map((attribute) => attribute.name);
    expect(names).not.toContain('href');
    expect(names).not.toContain('id');
    expect(names).not.toContain('style');
    expect(names).not.toContain('class');
    // KaTeX marks its own refusal in red, and even that colour is not on the allowlist.
    expect(names).not.toContain('mathcolor');
  });

  it('[S02] drops the colours ordinary TeX does emit, since they are not on the list', () => {
    // Unlike the six above, these are attributes KaTeX really produces — `mathcolor` on
    // `mstyle`, `mathbackground` on `mspace` — so this is the attribute filter, observed.
    draw('$\\textcolor{red}{x}$ and $\\colorbox{red}{y}$ and $\\rule{1em}{1em}$\n');
    expect(container.querySelector('mstyle')).not.toBeNull();
    const names = attributesUnderMath().map((attribute) => attribute.name);
    expect(names).not.toContain('mathcolor');
    expect(names).not.toContain('mathbackground');
  });

  /**
   * The mutation this exists for: `dangerouslySetInnerHTML={{ __html: html }}` in place of the
   * rebuild. Every DOM assertion in this file still passes under it, because the DOM is the
   * same either way — what changes is how it got there, so that is what is asserted.
   */
  it('[S02] returns built elements, never an HTML string handed to the page', () => {
    const elements = elementsOf(renderMarkdown('The loss is $E = mc^2$ at convergence.\n'));
    expect(elements.length).toBeGreaterThan(0);
    for (const element of elements) {
      expect(
        'dangerouslySetInnerHTML' in (element.props as Record<string, unknown>),
        `${String(element.type)} was given an HTML string`,
      ).toBe(false);
    }
    // The MathML is in the returned tree as elements, not as text waiting to be parsed.
    const tags = elements.map((element) => element.type);
    expect(tags).toContain('math');
    expect(tags).toContain('semantics');
    expect(tags).toContain('mi');
  });

  it('[S02] caps a length the document names, so a formula cannot lay out the window', () => {
    // `\rule{99999em}{99999em}` reached the DOM as a ~1.6-million-pixel box inside the panel.
    draw('A $\\rule{99999em}{99999em}$ B\n');
    const space = container.querySelector('[data-testid="markdown-math"] mspace');
    expect(space).not.toBeNull();
    expect(space?.getAttribute('width')).toBe(`${String(MAX_USER_SIZE_EM)}em`);
    expect(space?.getAttribute('height')).toBe(`${String(MAX_USER_SIZE_EM)}em`);
  });

  it('[S02] leaves a length a formula actually needs alone', () => {
    draw('A $x\\hspace{2em}y$ and $\\rule{2em}{1em}$ B\n');
    const widths = [...container.querySelectorAll('[data-testid="markdown-math"] mspace')].map(
      (space) => space.getAttribute('width'),
    );
    expect(widths).toContain('2em');
  });
});
