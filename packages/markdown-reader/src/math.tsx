/**
 * LaTeX math, rendered locally (criterion S02).
 *
 * **Vendored, never fetched.** KaTeX is an ordinary dependency bundled into the renderer;
 * nothing here reaches the network, which is the milestone's rule and also the only way this
 * could work on a plane. It is asked for **MathML** rather than KaTeX's HTML+CSS output, and
 * that choice buys three things: no stylesheet to ship, no woff2 fonts to copy into the bundle
 * or to allow in `font-src`, and no licence surface beyond KaTeX's own MIT. Electron 33 is
 * Chromium 130, which renders MathML Core natively.
 *
 * **No HTML string reaches the page.** `render.tsx` opens by promising that nothing there
 * produces one, and every math renderer in existence returns exactly that — so the string
 * KaTeX generates is parsed with `DOMParser` and rebuilt as React elements against an
 * allowlist of MathML tags and attributes. An `\\href` or an `\\htmlData` that got through
 * KaTeX's own `trust: false` would still not survive this pass, because the allowlist names
 * what may exist rather than what may not. The alternative — `dangerouslySetInnerHTML` with a
 * comment explaining why it is safe — puts the app one KaTeX regression away from injection
 * into a privileged origin, and reads to the next auditor as the regression it looks like.
 *
 * **A formula that does not parse renders as what was typed.** `throwOnError: false` and the
 * fallbacks below: the researcher gets their source back, visibly marked as unrendered, rather
 * than a blank space where their equation was.
 *
 * Everything above is pinned by `tests/integration/markdown-math.test.ts`: the allowlists are
 * asserted by exact contents there, the rebuild is driven directly with hostile MathML, and the
 * shape of what `renderMarkdown` returns is walked as a React tree. That is deliberate — an
 * argument in a comment is not an instrument, and a swap of this file's body for
 * `dangerouslySetInnerHTML` passed every test that existed before those were written.
 */
import { Fragment, type JSX, type ReactNode } from 'react';
import katex from 'katex';

/**
 * The MathML Core elements KaTeX emits, and nothing else.
 *
 * `annotation` carries the original TeX in KaTeX's `semantics` wrapper — kept, because it is
 * what a copy-paste and a screen reader read, and it is text either way.
 *
 * Exported so a test can assert its contents rather than its effect: KaTeX with `trust: false`
 * never emits a tag outside this set, so nothing that goes through `renderMath` can notice the
 * difference between this list and a longer one.
 */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'math',
  'semantics',
  'annotation',
  'mrow',
  'mi',
  'mn',
  'mo',
  'ms',
  'mtext',
  'mspace',
  'msup',
  'msub',
  'msubsup',
  'mfrac',
  'msqrt',
  'mroot',
  'munder',
  'mover',
  'munderover',
  'mmultiscripts',
  'mprescripts',
  'none',
  'mtable',
  'mtr',
  'mtd',
  'mpadded',
  'mphantom',
  'menclose',
  'mstyle',
  'merror',
  'maction',
]);

/**
 * Presentation attributes only. No `href`, no `style`, no `on*`, no `id` — an id would let a
 * formula collide with the app's own anchors, and the rest are how markup becomes behaviour.
 *
 * Exported for the same reason as `ALLOWED_TAGS`, and it matters more here: adding `href`,
 * `style` or `id` changes nothing any rendering observes, because `trust: false` means KaTeX
 * never produces one. The absence is a decision, so the set is asserted rather than inferred.
 */
export const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
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

/** DOM attribute name -> React prop. Only the ones React would otherwise mangle or drop. */
const REACT_PROP: Readonly<Record<string, string>> = {
  class: 'className',
};

/**
 * One parsed node, rebuilt as React elements — the allowlist, applied.
 *
 * A tag that is not named is dropped **with its subtree**, and an attribute that is not named
 * is dropped from a tag that is.
 */
function toElements(node: Node, key: string): ReactNode {
  if (node.nodeType === 3 /* Node.TEXT_NODE */) {
    const text = node.nodeValue ?? '';
    return text === '' ? null : <Fragment key={key}>{text}</Fragment>;
  }
  if (node.nodeType !== 1 /* Node.ELEMENT_NODE */) return null;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) return null;

  const props: Record<string, string> = {};
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (!ALLOWED_ATTRIBUTES.has(name)) continue;
    props[REACT_PROP[name] ?? name] = attribute.value;
  }

  const children = Array.from(element.childNodes)
    .map((child, index) => toElements(child, `${key}.${String(index)}`))
    .filter((child) => child !== null);

  // A lowercase string tag is what makes these MathML elements rather than unknown HTML ones:
  // React puts everything under `<math>` in the MathML namespace.
  const Tag = tag as 'span';
  return (
    <Tag key={key} {...props}>
      {children.length === 0 ? null : children}
    </Tag>
  );
}

/**
 * An HTML string of MathML, as React elements — or `null` when there is no `<math>` in it.
 *
 * The whole security argument of this file is this function: the string a renderer produced is
 * *parsed*, never inserted. `DOMParser` builds a document with no browsing context, so nothing
 * in the string runs and nothing in it is fetched; what comes back out is whatever survived the
 * two allowlists. Exported so a test can hand it markup KaTeX would never emit — that is the
 * regression the docstring above is about, and it is not reachable through `renderMath`.
 */
export function elementsFromMathML(html: string, key: string): ReactNode | null {
  // Available in the renderer and in jsdom, which is where this is tested. Anywhere else —
  // a future main-process caller — the source is still the honest answer.
  if (typeof DOMParser === 'undefined') return null;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const math = parsed.body.querySelector('math');
  if (math === null) return null;
  return toElements(math, key);
}

/**
 * The source, shown as itself, when it could not become mathematics.
 *
 * It carries `data-tex` like a formula that did parse, and for the same reason: the
 * projection every anchor is measured against holds the TeX without its delimiters, while
 * what is drawn here is the delimiters and all. The attribute is how the reader reads a
 * selection back in the spelling the document uses.
 */
function unrendered(tex: string, display: boolean, key: string): JSX.Element {
  return (
    <code
      key={key}
      className={display ? 'wr-math wr-math--display wr-math--error' : 'wr-math wr-math--error'}
      data-testid="markdown-math-error"
      data-tex={tex}
      title="This did not parse as LaTeX"
    >
      {display ? `$$${tex}$$` : `$${tex}$`}
    </code>
  );
}

/**
 * The largest length a document may name, in ems.
 *
 * The allowlist admits MathML's length attributes, because `\\kern` and `\\raisebox` are
 * ordinary typesetting — and KaTeX's `maxSize` defaults to `Infinity`, so
 * `\\rule{99999em}{99999em}` in a markdown file, or in a highlight quoted onto a notebook page,
 * lays out a box of about 1.6 million CSS pixels inside a reader panel. Ten ems is wider than
 * any formula the researcher writes and narrower than anything that hurts.
 */
export const MAX_USER_SIZE_EM = 10;

/**
 * One formula, as React elements.
 *
 * `strict: 'ignore'` rather than `'warn'`: a warning here would be a console line nobody reads
 * about a document nobody is debugging. `trust: false` refuses `\\href`, `\\url` and
 * `\\includegraphics` at the source — the allowlist above would drop them anyway, and refusing
 * twice is the point.
 */
export function renderMath(tex: string, display: boolean, key: string): ReactNode {
  let html: string;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      output: 'mathml',
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      maxSize: MAX_USER_SIZE_EM,
    });
  } catch {
    return unrendered(tex, display, key);
  }

  const elements = elementsFromMathML(html, `${key}.m`);
  if (elements === null) return unrendered(tex, display, key);

  return (
    <span
      key={key}
      className={display ? 'wr-math wr-math--display' : 'wr-math'}
      data-testid="markdown-math"
      data-display={display ? 'block' : 'inline'}
      data-tex={tex}
    >
      {elements}
    </span>
  );
}
