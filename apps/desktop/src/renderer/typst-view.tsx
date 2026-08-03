/**
 * A compiled Typst document, drawn (criteria S04–S07).
 *
 * The compiler runs in the main process and answers with a **tree**, never an HTML string, so
 * there is nothing here that could be handed to `dangerouslySetInnerHTML` even by accident —
 * the same rule the markdown renderer keeps, arrived at the same way. The tree has already
 * been narrowed to an allow-list of tags and attributes on the other side of the channel;
 * this side turns it into React elements and decides what a *link* is worth, which is the one
 * thing the main process cannot know because navigation belongs to the workspace.
 *
 * Three link spellings arrive as ordinary `href`s and leave as three different things:
 * `annotation://`, `document://` and `note://` become the same chip the markdown renderer
 * draws (`S03`'s promise, in the new language), `wiki://` becomes a wikilink chip resolved
 * against the same table `[[target]]` uses, and anything else is drawn as inert text — nothing
 * in this window navigates by URL, and an `<a href>` the app has to intercept is one refresh
 * away from leaving the origin.
 *
 * Compilation is cached by source, because a page with forty blocks re-renders all forty
 * whenever any one of them commits and forty round trips per keystroke is the one way this
 * design could get expensive.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { parseInternalLink, parseWikilinkHref } from '@wr/document-model';
import type { InternalLink, TypstNode } from '@wr/shared-types';
import { call, describeError } from './ipc.js';

export interface TypstLinkHandlers {
  readonly activateInternal?: ((link: InternalLink) => void) | undefined;
  readonly activateWikilink?: ((target: string) => void) | undefined;
}

/** Elements that carry no children and must not be given any. */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

/** Turn a compiled tree into elements. */
export function renderTypstTree(node: TypstNode, handlers: TypstLinkHandlers = {}): ReactNode {
  return <>{drawChildren(node.children ?? [], '0', handlers)}</>;
}

function drawChildren(
  nodes: readonly TypstNode[],
  key: string,
  handlers: TypstLinkHandlers,
): ReactNode[] {
  return nodes.map((child, index) => draw(child, `${key}.${String(index)}`, handlers));
}

function draw(node: TypstNode, key: string, handlers: TypstLinkHandlers): ReactNode {
  if (node.type === 'text') return <span key={key}>{node.value ?? ''}</span>;
  const tag = node.tag ?? 'span';
  const props = node.props ?? {};
  if (tag === 'a') return drawLink(node, key, handlers);

  const children = drawChildren(node.children ?? [], key, handlers);
  const attributes: Record<string, string> = {};
  if (props['class'] !== undefined) attributes['className'] = props['class'];
  if (props['cite'] !== undefined) attributes['cite'] = props['cite'];
  if (props['title'] !== undefined) attributes['title'] = props['title'];
  if (tag === 'img') {
    // `src` is a `data:` URI the compiler inlined — a typeset formula, or a figure's own bytes.
    // The window's `img-src` already allows `data:`, so this costs no widening of the CSP, and
    // the allow-list on the other side of the channel refused anything that was not one.
    attributes['src'] = props['src'] ?? '';
    attributes['alt'] = props['alt'] ?? '';
  }
  const Tag = tag as keyof JSX.IntrinsicElements;
  if (VOID_TAGS.has(tag)) return <Tag key={key} {...attributes} />;
  return (
    <Tag key={key} {...attributes}>
      {children}
    </Tag>
  );
}

function drawLink(node: TypstNode, key: string, handlers: TypstLinkHandlers): ReactNode {
  const href = node.props?.['href'] ?? '';
  const label = drawChildren(node.children ?? [], key, handlers);

  const internal = parseInternalLink(href);
  if (internal !== null) {
    const id =
      internal.scheme === 'annotation'
        ? internal.annotationId
        : internal.scheme === 'note'
          ? internal.noteId
          : internal.documentId;
    return (
      <button
        key={key}
        type="button"
        className="wr-internal-link"
        data-testid={`internal-link-${id}`}
        data-scheme={internal.scheme}
        data-target={id}
        title="Go to the source"
        disabled={handlers.activateInternal === undefined}
        onClick={() => handlers.activateInternal?.(internal)}
      >
        {label}
      </button>
    );
  }

  const wiki = parseWikilinkHref(href);
  if (wiki !== null) {
    const slug = wiki.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '');
    return (
      <button
        key={key}
        type="button"
        className="wr-wikilink"
        data-testid={`wikilink-${slug}`}
        data-slug={slug}
        title={wiki}
        onClick={() => handlers.activateWikilink?.(wiki)}
      >
        {label}
      </button>
    );
  }

  // Not a scheme this window can reach. Drawn as the text it is: an inert anchor would still
  // be an anchor, and the whole point of the two branches above is that navigation is a
  // command rather than a URL.
  return (
    <span key={key} className="wr-typst-link--inert" title={href}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Compiling
// ---------------------------------------------------------------------------

export interface TypstRendering {
  readonly tree: TypstNode | null;
  readonly svg: string | null;
  readonly error: string | null;
  readonly pending: boolean;
}

/**
 * Everything compiled so far, by notebook, language revision and source.
 *
 * Bounded, because a page being written produces one entry per commit and a session is long.
 * Oldest-inserted goes first, which is a `Map`'s own iteration order.
 */
const CACHE = new Map<string, TypstRendering>();
const CACHE_LIMIT = 512;

/**
 * Which generation of the headers a cached compile belongs to.
 *
 * A header changes what *every* block of a notebook compiles to without any block's source
 * changing, so a cache keyed on source alone would go on drawing the old definitions. Bumping
 * one number is the whole invalidation.
 */
let revision = 0;
const listeners = new Set<() => void>();

export function typstHeadersChanged(): void {
  revision += 1;
  CACHE.clear();
  for (const listener of listeners) listener();
}

function remember(key: string, value: TypstRendering): void {
  if (CACHE.size >= CACHE_LIMIT) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.set(key, value);
}

const PENDING: TypstRendering = { tree: null, svg: null, error: null, pending: true };

/**
 * Compile a piece of Typst, and answer with what it came to.
 *
 * `debounceMs` is zero for a block — a block's source only changes when it is committed, so
 * there is nothing to wait for — and a few hundred milliseconds for the live render, which
 * follows the whole document while it is being typed.
 */
export function useTypstRender(
  source: string,
  options: {
    readonly questionId?: string | null | undefined;
    readonly target?: 'html' | 'svg' | undefined;
    readonly widthPt?: number | undefined;
    readonly debounceMs?: number | undefined;
  } = {},
): TypstRendering {
  const questionId = options.questionId ?? null;
  const target = options.target ?? 'html';
  const widthPt = Math.max(64, Math.round(options.widthPt ?? 480));
  const debounceMs = options.debounceMs ?? 0;
  const key = `${String(revision)}|${questionId ?? ''}|${target}|${target === 'svg' ? String(widthPt) : ''}|${source}`;
  const [rendering, setRendering] = useState<TypstRendering>(() => CACHE.get(key) ?? PENDING);

  useEffect(() => {
    const cached = CACHE.get(key);
    if (cached !== undefined) {
      setRendering(cached);
      return undefined;
    }
    let live = true;
    setRendering(PENDING);
    const run = (): void => {
      void call('typst:render', { questionId, source, target, widthPt })
        .then((answer) => {
          const done: TypstRendering = { ...answer, pending: false };
          remember(key, done);
          if (live) setRendering(done);
        })
        .catch((failure: unknown) => {
          if (live) {
            setRendering({
              tree: null,
              svg: null,
              error: describeError(failure).message,
              pending: false,
            });
          }
        });
    };
    if (debounceMs === 0) {
      run();
      return () => {
        live = false;
      };
    }
    const timer = setTimeout(run, debounceMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, questionId, source, target, widthPt, debounceMs]);

  // A header saved elsewhere invalidates every cached compile, and the surfaces on screen have
  // to hear about it — otherwise the page keeps drawing definitions that no longer exist.
  const [, redraw] = useState(0);
  useEffect(() => {
    const listener = (): void => redraw((count) => count + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return rendering;
}
