/**
 * @wr/markdown-reader — renders a markdown document in its original form.
 *
 * The source is turned into React elements from the mdast, node by node. There is no
 * `dangerouslySetInnerHTML` and no HTML string anywhere in this file: a corpus file can
 * contain raw HTML, and a markdown reader that pastes it into the DOM would be an injection
 * point in a window that is otherwise sandboxed. Raw HTML blocks render as the text the
 * author wrote, visibly, rather than being executed or silently dropped.
 *
 * Wikilinks are rendered as chips, resolved or wanted, and are the only place this view knows
 * about the corpus: what a chip *does* when clicked is the workbench's decision, handed in.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  MARKDOWN_PARSER_VERSION,
  normalizeText,
  parseMarkdown,
  type MarkdownWikilink,
} from '@wr/document-model';
import type {
  AnnotationWithAnchor,
  MarkdownLocation,
  MarkdownReaderSelection,
} from '@wr/shared-types';
import { renderMarkdown, type WikilinkRenderer } from './render.js';

export interface MarkdownReaderViewProps {
  readonly documentId: string;
  /** `rrfile://<fileId>` — the only way bytes reach this component. */
  readonly fileUrl: string;
  readonly annotations: readonly AnnotationWithAnchor[];
  readonly selectedAnnotationId?: string | null;
  readonly initialLocation?: MarkdownLocation | null;
  readonly revealLocation?: MarkdownLocation | null;
  readonly onSelection?: (selection: MarkdownReaderSelection | null) => void;
  /**
   * A plain click landed on a painted highlight, or — with `null` — beside one. The reader's
   * own way into a highlight's comment, so it need not be reached through the sidebar.
   */
  readonly onActivateHighlight?: (annotationId: string | null) => void;
  readonly onLocationChange?: (location: MarkdownLocation) => void;
  /** Resolve a `[[slug]]` for display: `null` means the page is wanted, not written. */
  readonly resolveWikilink?: (slug: string) => { documentId: string; title: string } | null;
  readonly onWikilinkActivate?: (link: MarkdownWikilink) => void;
  readonly onError?: (message: string) => void;
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly source: string }
  | { readonly status: 'error'; readonly message: string };

export function MarkdownReaderView(props: MarkdownReaderViewProps): JSX.Element {
  const { documentId, fileUrl, onError, onSelection } = props;
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;

  // --- load ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const response = await fetch(fileUrl);
        if (!response.ok) {
          throw new Error(`${String(response.status)} ${response.statusText}`);
        }
        const source = await response.text();
        if (!cancelled) setState({ status: 'ready', source });
      } catch (error) {
        // A document that cannot be read is reported, never replaced by its extracted text:
        // the reading view shows the document or says why it cannot.
        const message = `Could not read this markdown file: ${
          error instanceof Error ? error.message : String(error)
        }`;
        if (!cancelled) {
          setState({ status: 'error', message });
          errorRef.current?.(message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on the URL alone. `onError` is an inline arrow at the call site, so a fresh
    // identity every render — depending on it re-fetched the file and reset the status to
    // 'loading' whenever anything in the workspace changed, throwing away the reader's
    // scroll position. Same defect as `[UX07]` fixed in the saved-page reader.
  }, [fileUrl]);

  const source = state.status === 'ready' ? state.source : '';
  const parsed = useMemo(() => (source === '' ? null : parseMarkdown(source)), [source]);
  const documentText = parsed === null ? '' : normalizeText(parsed.text);

  // --- selection ----------------------------------------------------------
  const captureSelection = useCallback(() => {
    if (onSelection === undefined || parsed === null) return;
    const selection = window.getSelection();
    const text = selection === null ? '' : normalizeText(selection.toString());
    if (text.length === 0) {
      onSelection(null);
      return;
    }
    const container = scrollRef.current;
    if (container === null || selection === null || selection.rangeCount === 0) return;
    if (!container.contains(selection.anchorNode)) return;

    // Offsets are computed against the *normalized document text*, not against the DOM: the
    // DOM here is one rendering of the file and the file is what the anchor has to survive.
    const start = documentText.indexOf(text);
    if (start === -1) {
      onSelection(null);
      return;
    }
    const headingPath = headingPathForNode(selection.anchorNode, container);
    onSelection({
      kind: 'markdown',
      text,
      documentText,
      position: { start, end: start + text.length },
      ...(headingPath === null ? {} : { headingPath }),
    });
  }, [documentText, onSelection, parsed]);

  // --- reveal and reading position ----------------------------------------
  const reveal = props.revealLocation ?? null;
  const initial = props.initialLocation ?? null;
  useEffect(() => {
    const target = reveal ?? initial;
    const container = scrollRef.current;
    if (target === null || container === null || parsed === null) return;
    if (target.headingPath !== undefined) {
      const heading = container.querySelector(
        `[data-heading-path="${cssEscape(target.headingPath)}"]`,
      );
      if (heading instanceof HTMLElement) {
        container.scrollTop = heading.offsetTop - container.offsetTop;
        return;
      }
    }
    if (target.offsetRatio !== undefined) {
      container.scrollTop = target.offsetRatio * container.scrollHeight;
    }
  }, [initial, parsed, reveal]);

  const onScroll = useCallback(() => {
    const container = scrollRef.current;
    if (container === null || props.onLocationChange === undefined) return;
    const ratio =
      container.scrollHeight === 0 ? 0 : container.scrollTop / container.scrollHeight;
    const heading = visibleHeadingPath(container);
    props.onLocationChange({
      kind: 'markdown',
      offsetRatio: Math.min(1, Math.max(0, ratio)),
      ...(heading === null ? {} : { headingPath: heading }),
    });
  }, [props]);

  const wikilinkRenderer: WikilinkRenderer = useMemo(
    () => ({
      resolve: (slug) => props.resolveWikilink?.(slug) ?? null,
      activate: (link) => props.onWikilinkActivate?.(link),
    }),
    [props],
  );

  const highlights = useMemo(
    () =>
      props.annotations.flatMap((annotation) =>
        annotation.anchor.kind === 'markdown'
          ? [
              {
                id: annotation.id,
                text: annotation.anchor.quote.exact,
                color: annotation.color,
                selected: annotation.id === (props.selectedAnnotationId ?? null),
              },
            ]
          : [],
      ),
    [props.annotations, props.selectedAnnotationId],
  );

  // --- opening a highlight -------------------------------------------------
  /**
   * Which highlight, if any, a click landed in.
   *
   * Read off the DOM rather than bound as a handler on each `<mark>`: the markup is produced
   * by a pure render function, and one delegated listener is also what keeps a highlight
   * split across several `<mark>` runs from needing a handler per run.
   */
  const onClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const activate = props.onActivateHighlight;
      if (activate === undefined) return;
      // A drag that selected text is not a click on what lies under its end point.
      const selection = window.getSelection();
      if (selection !== null && !selection.isCollapsed) return;

      const target = event.target instanceof Element ? event.target : null;
      const mark = target?.closest<HTMLElement>('[data-annotation-id]') ?? null;
      activate(mark?.dataset['annotationId'] ?? null);
    },
    [props.onActivateHighlight],
  );

  if (state.status === 'loading') {
    return (
      <div className="wr-markdown" data-testid="markdown-reader-loading">
        Opening document…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="wr-markdown wr-markdown--error" data-testid="markdown-reader-error">
        {state.message}
      </div>
    );
  }

  const body: ReactNode =
    parsed === null ? null : renderMarkdown(state.source, { wikilinks: wikilinkRenderer, highlights });

  return (
    <div
      className="wr-markdown"
      data-testid="markdown-reader"
      data-document-id={documentId}
      data-parser-version={String(MARKDOWN_PARSER_VERSION)}
    >
      <div
        className="wr-markdown__scroll"
        data-testid="markdown-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        onClick={onClick}
      >
        <article className="wr-markdown__body" data-testid="markdown-body">
          {body}
        </article>
      </div>
    </div>
  );
}

/** The heading a DOM node sits under, read off the rendered heading markers. */
function headingPathForNode(node: Node | null, container: HTMLElement): string | null {
  let element: HTMLElement | null =
    node === null ? null : node instanceof HTMLElement ? node : node.parentElement;
  while (element !== null && container.contains(element)) {
    let sibling: Element | null = element;
    while (sibling !== null) {
      const path = sibling instanceof HTMLElement ? sibling.dataset['headingPath'] : undefined;
      if (path !== undefined) return path;
      sibling = sibling.previousElementSibling;
    }
    element = element.parentElement;
  }
  return null;
}

/** The last heading scrolled past, which is the section the reader is in. */
function visibleHeadingPath(container: HTMLElement): string | null {
  const headings = container.querySelectorAll('[data-heading-path]');
  let current: string | null = null;
  for (const heading of headings) {
    if (!(heading instanceof HTMLElement)) continue;
    if (heading.offsetTop - container.offsetTop > container.scrollTop + 8) break;
    current = heading.dataset['headingPath'] ?? current;
  }
  return current;
}

/**
 * Escape a value for use inside an attribute selector.
 *
 * `CSS.escape` is not available in every environment this renders in (jsdom under test), and
 * a heading path is user text — quoting it by hand is what keeps a heading named `a"]` from
 * changing which element the selector matches.
 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
