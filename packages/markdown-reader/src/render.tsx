/**
 * mdast -> React elements.
 *
 * Written out node by node rather than delegating to an HTML pipeline, for two reasons. The
 * first is safety: nothing here produces an HTML string, so a corpus file containing
 * `<script>` renders as the characters the author typed. The second is that `[[wikilinks]]`
 * have to become interactive chips, and they live inside `text` nodes — which means the text
 * renderer, not a plugin, is where they are handled.
 *
 * Highlights are painted per *block*, not per text node. A highlight is a quote of the
 * document's normalized text, and the sentence it quotes routinely runs across a wikilink
 * chip, a bold word or a piece of inline code — so the block is flattened, folded the way
 * the anchor's quote was folded, matched, and then rebuilt with marks in it.
 */
import { Fragment, type JSX, type ReactNode } from 'react';
import GithubSlugger from 'github-slugger';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { toString as mdastToString } from 'mdast-util-to-string';
import { unified } from 'unified';
import type { Root, RootContent } from 'mdast';
import { highlightColorVariable, type HighlightColor } from '@wr/shared-types';
import { normalizeText, slugify, type MarkdownWikilink } from '@wr/document-model';

export interface RenderedHighlight {
  readonly id: string;
  readonly text: string;
  readonly color: HighlightColor;
  readonly selected: boolean;
}

export interface WikilinkRenderer {
  readonly resolve: (slug: string) => { documentId: string; title: string } | null;
  readonly activate: (link: MarkdownWikilink) => void;
}

export interface RenderOptions {
  readonly wikilinks?: WikilinkRenderer | undefined;
  readonly highlights?: readonly RenderedHighlight[] | undefined;
}

const processor = unified().use(remarkParse).use(remarkGfm);

const WIKILINK_RE = /\[\[([^\]\n|#]+)(?:#([^\]\n|]+))?(?:\|([^\]\n]*))?\]\]/g;

export function renderMarkdown(source: string, options: RenderOptions = {}): ReactNode {
  // Composed once here, so what is drawn and what a highlight's quote is matched against are
  // the same characters. `normalizeText` composes too, and an anchor made on a decomposed
  // source would otherwise never find its own sentence again.
  const tree = processor.parse(source.normalize('NFC')) as Root;
  const slugger = new GithubSlugger();
  const context: Context = {
    slugger,
    headingStack: [],
    ...(options.wikilinks === undefined ? {} : { wikilinks: options.wikilinks }),
    highlights: options.highlights ?? [],
  };
  return <>{tree.children.map((node, index) => renderNode(node, `${String(index)}`, context))}</>;
}

interface Context {
  readonly slugger: GithubSlugger;
  headingStack: { depth: number; path: string }[];
  readonly wikilinks?: WikilinkRenderer;
  readonly highlights: readonly RenderedHighlight[];
}

function children(nodes: readonly RootContent[], key: string, context: Context): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, `${key}.${String(index)}`, context));
}

/** One branch per mdast node type; splitting it would only move the switch somewhere less obvious. */
function renderNode(node: RootContent, key: string, context: Context): ReactNode {
  switch (node.type) {
    case 'heading': {
      const text = mdastToString(node).trim();
      const slug = context.slugger.slug(text.trim().replace(/\s+/g, ' '));
      while (
        context.headingStack.length > 0 &&
        (context.headingStack[context.headingStack.length - 1]?.depth ?? 0) >= node.depth
      ) {
        context.headingStack.pop();
      }
      const parent = context.headingStack[context.headingStack.length - 1];
      const path = parent === undefined ? slug : `${parent.path}/${slug}`;
      context.headingStack.push({ depth: node.depth, path });
      const Tag = `h${String(Math.min(6, node.depth))}` as 'h1';
      return (
        <Tag key={key} id={slug} data-heading-path={path} data-testid={`markdown-heading-${slug}`}>
          {inline(node.children, key, context)}
        </Tag>
      );
    }
    case 'paragraph':
      return <p key={key}>{inline(node.children, key, context)}</p>;
    case 'blockquote':
      return <blockquote key={key}>{children(node.children, key, context)}</blockquote>;
    case 'list':
      return node.ordered === true ? (
        <ol key={key} start={node.start ?? 1}>
          {children(node.children, key, context)}
        </ol>
      ) : (
        <ul key={key}>{children(node.children, key, context)}</ul>
      );
    case 'listItem':
      return (
        <li key={key} data-checked={node.checked === null ? undefined : String(node.checked)}>
          {children(node.children, key, context)}
        </li>
      );
    case 'code':
      return (
        <pre key={key} data-testid="markdown-code" data-lang={node.lang ?? undefined}>
          <code>{node.value}</code>
        </pre>
      );
    case 'inlineCode':
      return <code key={key}>{node.value}</code>;
    case 'emphasis':
      return <em key={key}>{children(node.children, key, context)}</em>;
    case 'strong':
      return <strong key={key}>{children(node.children, key, context)}</strong>;
    case 'delete':
      return <del key={key}>{children(node.children, key, context)}</del>;
    case 'break':
      return <br key={key} />;
    case 'thematicBreak':
      return <hr key={key} />;
    case 'link':
      return (
        <a key={key} href={safeHref(node.url)} title={node.title ?? undefined}>
          {children(node.children, key, context)}
        </a>
      );
    case 'image':
      return <img key={key} src={safeHref(node.url)} alt={node.alt ?? ''} title={node.title ?? undefined} />;
    case 'table':
      return (
        <table key={key}>
          <tbody>{children(node.children, key, context)}</tbody>
        </table>
      );
    case 'tableRow':
      return <tr key={key}>{children(node.children, key, context)}</tr>;
    case 'tableCell':
      return <td key={key}>{inline(node.children, key, context)}</td>;
    case 'text':
      return <Fragment key={key}>{renderText(node.value, key, context)}</Fragment>;
    case 'html':
      // Raw HTML in a corpus file is shown as what it is. Rendering it would mean handing an
      // arbitrary file the ability to inject markup into a privileged origin.
      return (
        <code key={key} className="wr-markdown__raw-html" data-testid="markdown-raw-html">
          {node.value}
        </code>
      );
    default:
      // Footnotes, definitions and anything a future remark plugin adds: fall back to the
      // node's own text rather than dropping content the file contains.
      return <Fragment key={key}>{mdastToString(node)}</Fragment>;
  }
}

/**
 * A text node, split around wikilinks.
 *
 * A wikilink chip is a single unit, so a run of plain text is whatever lies between two of
 * them. Highlights are not applied here — they are a property of the whole block, because a
 * marked sentence routinely runs across a chip, a bold word or a piece of inline code. See
 * `inline` below.
 */
function renderText(value: string, key: string, context: Context): ReactNode {
  return textAtoms(value, key, context).map((atom) =>
    atom.kind === 'text' ? <Fragment key={atom.key}>{atom.value}</Fragment> : atom.node,
  );
}

function renderWikilink(
  key: string,
  target: string,
  section: string,
  alias: string,
  context: Context,
): ReactNode {
  const slug = slugify(target);
  const resolution = context.wikilinks?.resolve(slug) ?? null;
  const label = alias.length > 0 ? alias : target;
  const link: MarkdownWikilink = {
    target,
    slug,
    section: section.length === 0 ? null : slugify(section),
    alias: alias.length === 0 ? null : alias,
    sourceStart: 0,
    sourceEnd: 0,
    headingPath: context.headingStack[context.headingStack.length - 1]?.path ?? '',
  };

  return (
    <button
      key={key}
      type="button"
      className={resolution === null ? 'wr-wikilink wr-wikilink--wanted' : 'wr-wikilink'}
      data-testid={`wikilink-${slug}`}
      data-slug={slug}
      data-wanted={resolution === null ? 'true' : 'false'}
      title={resolution === null ? `${target} — not written yet` : resolution.title}
      onClick={() => context.wikilinks?.activate(link)}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Painting highlights
// ---------------------------------------------------------------------------

/**
 * One piece of a block's inline content.
 *
 * `text` is a run of plain characters and can be cut anywhere. `opaque` is something already
 * rendered that a mark may wrap but must not split — a wikilink chip, inline code, a bold
 * word, a link. Both carry the text they put on screen, which is what a highlight's quote is
 * matched against.
 */
type Atom =
  | { readonly kind: 'text'; readonly key: string; readonly value: string }
  | { readonly kind: 'opaque'; readonly key: string; readonly value: string; readonly node: ReactNode };

/** A stretch of the block's folded text that one highlight covers. */
interface PaintRange {
  readonly highlight: RenderedHighlight;
  readonly start: number;
  readonly end: number;
}

/**
 * Soft hyphen, zero-width space / non-joiner / joiner, word joiner, BOM.
 *
 * Written as escapes rather than literals, for the reason `normalize.ts` gives: these
 * characters are invisible in an editor, so a stray one pasted into this file would be
 * undetectable in review. The *folding* itself is not restated here — `normalizeText` is the
 * authority on it and is called a character at a time, so every folded character can be
 * traced back to the one it came from.
 */
// Alternation rather than a character class, the way `normalize.ts` writes it: a class holding
// the zero-width joiner reads to a linter as a joined sequence.
const ZERO_WIDTH = /\u00ad|\u200b|\u200c|\u200d|\u2060|\ufeff/;

/**
 * A block's text as an anchor's quote spells it, with every character traceable back.
 *
 * The quote stored on an anchor is `normalizeText` output — whitespace collapsed, curly
 * quotes and dashes folded — while the markdown source is hard-wrapped and full of the
 * author's own punctuation. Matching one against the other directly is why a sentence broken
 * over two source lines never painted. So the block is folded the same way `normalizeText`
 * folds, one character at a time, and each folded character remembers the atom and offset it
 * came from.
 */
function foldBlock(atoms: readonly Atom[]): {
  readonly text: string;
  readonly from: readonly { readonly atom: number; readonly offset: number }[];
} {
  let text = '';
  const from: { atom: number; offset: number }[] = [];
  atoms.forEach((atom, index) => {
    const value = atom.value;
    for (let offset = 0; offset < value.length; offset += 1) {
      const character = value[offset] ?? '';
      if (ZERO_WIDTH.test(character)) continue;
      // `\s` in JavaScript already covers the non-breaking and quad spaces `normalizeText`
      // folds, so one test does for all of them.
      if (/\s/.test(character)) {
        if (text.endsWith(' ') || text === '') continue;
        text += ' ';
        from.push({ atom: index, offset });
        continue;
      }
      // ASCII is its own normal form, which keeps the call off the hot path for almost every
      // character in almost every document.
      const folded = character.charCodeAt(0) < 0x80 ? character : normalizeText(character);
      if (folded === '') continue;
      text += folded;
      for (let n = 0; n < folded.length; n += 1) from.push({ atom: index, offset });
    }
  });
  return { text, from };
}

/**
 * Where each highlight lands in the folded block, with overlaps dropped.
 *
 * Two highlights over the same words is a legitimate state — a passage marked twice — but a
 * single run of characters can only be inside one `<mark>`, so the earlier range wins and the
 * later one is drawn wherever it does not collide.
 */
function paintRanges(text: string, highlights: readonly RenderedHighlight[]): PaintRange[] {
  const found: PaintRange[] = [];
  for (const highlight of highlights) {
    if (highlight.text === '') continue;
    let at = text.indexOf(highlight.text);
    while (at !== -1) {
      found.push({ highlight, start: at, end: at + highlight.text.length });
      at = text.indexOf(highlight.text, at + highlight.text.length);
    }
  }
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const kept: PaintRange[] = [];
  for (const range of found) {
    const last = kept[kept.length - 1];
    if (last !== undefined && range.start < last.end) continue;
    kept.push(range);
  }
  return kept;
}

function Mark({
  highlight,
  children: body,
}: {
  readonly highlight: RenderedHighlight;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <mark
      className={highlight.selected ? 'wr-highlight wr-highlight--selected' : 'wr-highlight'}
      data-testid={`markdown-highlight-${highlight.id}`}
      // Read back by the view when a click lands inside a highlight. Kept as data rather
      // than as a handler here so this renderer stays a pure function of the source.
      data-annotation-id={highlight.id}
      data-color={highlight.color}
      style={{ background: highlightColorVariable(highlight.color) }}
    >
      {body}
    </mark>
  );
}

/**
 * One block of inline content, with every highlight that falls inside it painted.
 *
 * The block is flattened to atoms once, folded, matched, and then rebuilt: a text atom is cut
 * at the mark's edges, and an atom that cannot be cut is wrapped whole. That is what lets a
 * marked sentence carry across a `[[wikilink]]` — which is most sentences in a wiki.
 */
function inline(nodes: readonly RootContent[], key: string, context: Context): ReactNode[] {
  const atoms = inlineAtoms(nodes, key, context);
  if (context.highlights.length === 0) {
    return atoms.map((atom) =>
      atom.kind === 'text' ? <Fragment key={atom.key}>{atom.value}</Fragment> : atom.node,
    );
  }

  const { text, from } = foldBlock(atoms);
  const ranges = paintRanges(text, context.highlights);
  if (ranges.length === 0) {
    return atoms.map((atom) =>
      atom.kind === 'text' ? <Fragment key={atom.key}>{atom.value}</Fragment> : atom.node,
    );
  }

  // Each range, expressed as the slice of each atom it covers.
  const cover = new Map<number, { range: PaintRange; lo: number; hi: number }[]>();
  for (const range of ranges) {
    for (let at = range.start; at < range.end; at += 1) {
      const origin = from[at];
      if (origin === undefined) continue;
      const list = cover.get(origin.atom) ?? [];
      const last = list[list.length - 1];
      if (last !== undefined && last.range === range) {
        last.hi = Math.max(last.hi, origin.offset + 1);
      } else {
        list.push({ range, lo: origin.offset, hi: origin.offset + 1 });
      }
      cover.set(origin.atom, list);
    }
  }

  return atoms.flatMap((atom, index) => {
    const spans = cover.get(index);
    if (spans === undefined || spans.length === 0) {
      return [atom.kind === 'text' ? <Fragment key={atom.key}>{atom.value}</Fragment> : atom.node];
    }
    if (atom.kind === 'opaque') {
      // A chip, a bold word or a piece of code the mark reaches into: wrapped rather than
      // cut, so the element keeps whatever it is and still reads as marked.
      const first = spans[0];
      if (first === undefined) return [atom.node];
      return [
        <Mark key={atom.key} highlight={first.range.highlight}>
          {atom.node}
        </Mark>,
      ];
    }
    const out: ReactNode[] = [];
    let cursor = 0;
    spans.forEach((span, ordinal) => {
      // Two marks can meet on one character when a fold expanded it — an ellipsis becomes
      // three. Whoever got there first keeps it, rather than the text being drawn twice.
      const lo = Math.max(span.lo, cursor);
      if (lo >= span.hi) return;
      if (lo > cursor) {
        out.push(<Fragment key={`${atom.key}.p${String(ordinal)}`}>{atom.value.slice(cursor, lo)}</Fragment>);
      }
      out.push(
        <Mark key={`${atom.key}.m${String(ordinal)}`} highlight={span.range.highlight}>
          {atom.value.slice(lo, span.hi)}
        </Mark>,
      );
      cursor = span.hi;
    });
    if (cursor < atom.value.length) {
      out.push(<Fragment key={`${atom.key}.z`}>{atom.value.slice(cursor)}</Fragment>);
    }
    return out;
  });
}

/** Flatten phrasing content to atoms, in the order it is drawn. */
function inlineAtoms(nodes: readonly RootContent[], key: string, context: Context): Atom[] {
  return nodes.flatMap((node, index) => {
    const childKey = `${key}.${String(index)}`;
    if (node.type === 'text') return textAtoms(node.value, childKey, context);
    // Everything else keeps whatever element it renders as: a mark may wrap it, never split
    // it. `break` reads as the space it puts between two words.
    const value =
      node.type === 'break' ? ' ' : node.type === 'image' ? '' : mdastToString(node);
    return [
      { kind: 'opaque' as const, key: childKey, value, node: renderNode(node, childKey, context) },
    ];
  });
}

/** A text node's own atoms: plain runs, and a chip for each `[[wikilink]]` between them. */
function textAtoms(value: string, key: string, context: Context): Atom[] {
  const atoms: Atom[] = [];
  let cursor = 0;
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = WIKILINK_RE.exec(value)) !== null) {
    if (match.index > cursor) {
      atoms.push({
        kind: 'text',
        key: `${key}.t${String(cursor)}`,
        value: value.slice(cursor, match.index),
      });
    }
    const target = (match[1] ?? '').trim();
    const section = match[2]?.trim() ?? '';
    const alias = match[3]?.trim() ?? '';
    const chipKey = `${key}.w${String(match.index)}`;
    atoms.push({
      kind: 'opaque',
      key: chipKey,
      // What the chip puts on screen, which is what a selection over it read.
      value: alias.length > 0 ? alias : target,
      node: renderWikilink(chipKey, target, section, alias, context),
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) {
    atoms.push({ kind: 'text', key: `${key}.t${String(cursor)}`, value: value.slice(cursor) });
  }
  return atoms;
}

/**
 * Only schemes a local reader may follow.
 *
 * `javascript:` and `data:` in a corpus file are refused outright rather than sanitized: the
 * window blocks navigation anyway, but a link that looks live and does nothing is worse than
 * one that is visibly inert.
 */
function safeHref(url: string): string {
  const trimmed = url.trim();
  if (/^(https?:|mailto:|rrfile:|#|\.|\/)/i.test(trimmed)) return trimmed;
  return '#';
}

export function renderMarkdownToElement(source: string, options: RenderOptions = {}): JSX.Element {
  return <>{renderMarkdown(source, options)}</>;
}
