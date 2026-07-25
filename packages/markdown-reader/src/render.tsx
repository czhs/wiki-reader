/**
 * mdast -> React elements.
 *
 * Written out node by node rather than delegating to an HTML pipeline, for two reasons. The
 * first is safety: nothing here produces an HTML string, so a corpus file containing
 * `<script>` renders as the characters the author typed. The second is that `[[wikilinks]]`
 * have to become interactive chips, and they live inside `text` nodes — which means the text
 * renderer, not a plugin, is where they are handled.
 *
 * Highlights are painted the same way: a highlight is a quote, and a quote is a substring of
 * a text node, so the same splitter serves both.
 */
import { Fragment, type JSX, type ReactNode } from 'react';
import GithubSlugger from 'github-slugger';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { toString as mdastToString } from 'mdast-util-to-string';
import { unified } from 'unified';
import type { Root, RootContent } from 'mdast';
import { highlightColorVariable, type HighlightColor } from '@wr/shared-types';
import { slugify, type MarkdownWikilink } from '@wr/document-model';

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
  const tree = processor.parse(source) as Root;
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
          {children(node.children, key, context)}
        </Tag>
      );
    }
    case 'paragraph':
      return <p key={key}>{children(node.children, key, context)}</p>;
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
      return <td key={key}>{children(node.children, key, context)}</td>;
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
 * A text node, split around wikilinks and then around highlight quotes.
 *
 * Order matters: a wikilink chip is a single unit, so highlights are applied to the plain
 * runs between chips rather than being allowed to cut one in half.
 */
function renderText(value: string, key: string, context: Context): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = WIKILINK_RE.exec(value)) !== null) {
    if (match.index > cursor) {
      parts.push(...highlightRuns(value.slice(cursor, match.index), `${key}.t${String(cursor)}`, context));
    }
    const target = (match[1] ?? '').trim();
    const section = match[2]?.trim() ?? '';
    const alias = match[3]?.trim() ?? '';
    parts.push(renderWikilink(`${key}.w${String(match.index)}`, target, section, alias, context));
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) {
    parts.push(...highlightRuns(value.slice(cursor), `${key}.t${String(cursor)}`, context));
  }
  return parts;
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

/** Split a run of plain text around any highlight quote it contains. */
function highlightRuns(text: string, key: string, context: Context): ReactNode[] {
  for (const highlight of context.highlights) {
    const index = highlight.text.length === 0 ? -1 : text.indexOf(highlight.text);
    if (index === -1) continue;
    const before = text.slice(0, index);
    const after = text.slice(index + highlight.text.length);
    return [
      ...(before === '' ? [] : highlightRuns(before, `${key}.b`, context)),
      <mark
        key={`${key}.h${highlight.id}`}
        className={highlight.selected ? 'wr-highlight wr-highlight--selected' : 'wr-highlight'}
        data-testid={`markdown-highlight-${highlight.id}`}
        data-color={highlight.color}
        style={{ background: highlightColorVariable(highlight.color) }}
      >
        {highlight.text}
      </mark>,
      ...(after === '' ? [] : highlightRuns(after, `${key}.a`, context)),
    ];
  }
  return [<Fragment key={key}>{text}</Fragment>];
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
