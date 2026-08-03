/**
 * A field notebook's page (criteria N01, N03, N04, N05, N08, S01–S03, P06, P10, P12).
 *
 * This is where the paper gets written. The journal is notes to oneself; the notebook does
 * the heavy lifting, and a full publishable scientific paper has to be writable here —
 * headings and prose, LaTeX, code, pictures, and excerpts that keep their link to what was
 * read. So the page is the **same block editor the journal's day is** (`S01`).
 *
 * **The notebook is one document** (`P06`, `P10`). It had a margin holding front matter, an
 * outline and the claims, and a board along the bottom holding cards; the researcher's verdict
 * was that a page you write in should not be a quarter of its own panel. So the margin is gone
 * and its three parts are *sections of the page you scroll to*, and the desk is gone entirely —
 * what it held were `question-references-…` edges, and those now arrive as blocks in the page's
 * own markdown, which is a thing you can read, edit and write around. The edges are untouched;
 * what went was the second view of them.
 *
 * Four rules the panel keeps:
 *
 * - **The body is markdown source.** It is edited as source and stored as source; blocks are
 *   a view over that one document. A `contenteditable` storing HTML is the mistake this
 *   design exists to avoid, and it is also what would break search, the librarian and the
 *   excerpt links below.
 * - **Saving is explicit about having happened.** A block commits on blur, and the page says
 *   so, because a page that silently discards the last paragraph is worse than one that
 *   never had an editor.
 * - **The cover is a file id.** `rrfile://<id>` is built here; a path never reaches this
 *   process, so there is nothing to build one out of. The same is true of a picture dropped
 *   on the page: the preload resolves it and the main process writes the reference in.
 * - **An excerpt is markdown** (`S03`), not a private node type: a blockquote and an
 *   `annotation://` link. It survives search, the librarian and a text editor, and the link
 *   is what carries the reader back to the sentence it was cut from.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import {
  imageTypst,
  localDay,
  notebookSections,
  typstSections,
  TYPST_HEADING_TAG_OFFSET,
} from '@wr/document-model';
import { COMMAND_IDS } from '@wr/workbench';
import {
  HypothesisIdSchema,
  QuestionIdSchema,
  type HypothesisStatus,
  type NotebookPage,
  type ResolvedLink,
} from '@wr/shared-types';
import { call, describeError, subscribe } from './ipc.js';
import { BlockEditor, type BlockEditorHandle } from './blocks.js';
import { ExcerptPicker } from './excerpt-picker.js';
import { PicturePicker } from './picture-picker.js';
import { liveRenderPlacement, type LiveRenderPlacement } from './live-render.js';
import { LiveRender, TypstHeaders } from './notebook-typst.js';
import {
  usePanelDescriptor,
  useReportFailure,
  useWorkspace,
  type DockPanelProps,
} from './workspace.js';

/**
 * The attribute the preload's drop listener reads for anything dropped on the page (`P06`,
 * `S01`).
 *
 * The notebook's only drop target now that the desk has gone: a picture lands as a figure and
 * a paper lands as a reference, both as blocks written by the main process. Two targets on one
 * page meant the same gesture did different things a few pixels apart.
 */
const DROP_NOTEBOOK_PAGE_ATTRIBUTE = 'data-wr-drop-notebook-page';

const HYPOTHESIS_STATUSES: readonly HypothesisStatus[] = [
  'open',
  'supported',
  'refuted',
  'abandoned',
];

/** Tags are typed as a comma-separated line, which is how they read back too. */
const parseTags = (line: string): string[] =>
  line
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');

/**
 * A section of the page, and the control that folds it (`U09`).
 *
 * The page is one scrolling document (`P10`), which is what makes folding worth having: the
 * front matter and the claims are above and below the paragraph being written, and a long
 * paper means scrolling past both. Folding leaves the heading — the jump strip still reaches
 * it, and unfolds it on arrival — so nothing goes anywhere the researcher cannot get back.
 *
 * The whole heading is the button, not a chevron beside it, because a fold control the width
 * of one character is a fold control nobody finds.
 */
function SectionHead({
  part,
  label,
  count,
  folded,
  onToggle,
}: {
  readonly part: string;
  readonly label: string;
  readonly count?: number;
  readonly folded: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <h3 className="wr-list__section">
      <button
        type="button"
        className="wr-notebook__fold"
        aria-expanded={!folded}
        title={folded ? `Unfold ${label}` : `Fold ${label} out of the way`}
        data-control="notebook.fold"
        data-testid={`notebook-fold-${part}`}
        onClick={onToggle}
      >
        <span className="wr-notebook__fold-glyph" aria-hidden="true">
          {folded ? '▸' : '▾'}
        </span>
        {label}
      </button>
      {count !== undefined && <span className="wr-list__section-count">{count}</span>}
    </h3>
  );
}

function Citations({
  links,
  side,
  hypothesisId,
}: {
  readonly links: readonly ResolvedLink[];
  readonly side: 'supporting' | 'opposing';
  readonly hypothesisId: string;
}): JSX.Element {
  const { workbench } = useWorkspace();
  return (
    <ul className="wr-notebook__citations" data-testid={`notebook-${side}-${hypothesisId}`}>
      {/* A side with nothing on it still has its label, and a label naming nothing reads as a
          list that failed to load rather than as a claim nobody has argued yet. Say which it
          is — quietly, because a fresh notebook is mostly this. */}
      {links.length === 0 && (
        <li className="wr-notebook__citation-empty" data-testid={`notebook-${side}-${hypothesisId}-empty`}>
          Nothing yet
        </li>
      )}
      {links.map((link) => (
        <li key={link.id} className="wr-notebook__citation">
          <button
            type="button"
            className="wr-button wr-button--quiet"
            title={link.broken ? 'This citation no longer resolves' : 'Go to the source'}
            data-testid={`notebook-citation-${link.id}`}
            data-broken={link.broken ? 'true' : 'false'}
            disabled={link.broken}
            onClick={() => {
              // The same navigation every other citation in the app uses: the resolved link
              // already carries where its other end is.
              void workbench.navigate(
                {
                  entityId: link.direction === 'outgoing' ? link.targetId : link.sourceId,
                  entityType: link.otherType,
                  ...(link.otherDocumentId === null ? {} : { documentId: link.otherDocumentId }),
                  ...(link.otherLocation === null ? {} : { location: link.otherLocation }),
                },
                'current',
              );
            }}
          >
            {link.broken ? `${link.otherTitle} (missing)` : link.otherTitle}
          </button>
          {link.label !== null && <span className="wr-notebook__citation-note">{link.label}</span>}
        </li>
      ))}
    </ul>
  );
}

function NotebookView({
  questionId,
  onTitle,
}: {
  readonly questionId: string;
  readonly onTitle?: (title: string) => void;
}): JSX.Element {
  const { store, run } = useWorkspace();
  const [page, setPage] = useState<NotebookPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [claim, setClaim] = useState('');
  /** Which chooser is open, if either (`S03`, `S08`). */
  const [picking, setPicking] = useState<'excerpt' | 'image' | null>(null);
  /**
   * The sections folded out of the way (`U09`).
   *
   * Held here rather than persisted: a fold is a gesture about the paragraph you are on — "get
   * the front matter out of my way while I write this section" — and a page that reopened with
   * its claims hidden would be a page that had quietly lost them. The jump strip unfolds what
   * it goes to, so nothing can be folded past finding again.
   */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const editor = useRef<BlockEditorHandle | null>(null);

  const report = useReportFailure();

  const show = useCallback(
    (loaded: NotebookPage) => {
      setPage(loaded);
      onTitle?.(loaded.question.title);
    },
    [onTitle],
  );

  const load = useCallback(async () => {
    const parsed = QuestionIdSchema.safeParse(questionId);
    if (!parsed.success) {
      setError('This panel is not open on a notebook.');
      return;
    }
    try {
      const result = await call('question:notebook', { questionId: parsed.data });
      show(result.page);
      setError(null);
    } catch (failure) {
      setError(describeError(failure).message);
    }
  }, [questionId, show]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Take the page again.
   *
   * `withBody` is the whole subtlety. The body is a draft the researcher may be halfway
   * through, so a change that did not touch the markdown — an edge made in the reader beside
   * the page — must not replace what they have typed with what was last saved. A change that
   * *did* touch it must, and the block editor is the thing that reconciles the two: it merges
   * an outside append against the unsaved rows (`mergeAppend`) rather than dropping either.
   *
   * Deliberately not two functions. This used to keep the desk's cards out of the fresh
   * answer and throw the rest of it away, which meant `hypotheses` — where a claim's *For* and
   * *Against* lines live — could not be refreshed at all: evidence linked in the reader beside
   * the page arrived and the page went on showing an empty *For* until it was remounted.
   */
  const reload = useCallback(
    async (withBody: boolean) => {
      const parsed = QuestionIdSchema.safeParse(questionId);
      if (!parsed.success) return;
      try {
        const result = await call('question:notebook', { questionId: parsed.data });
        setPage((current) =>
          current === null || withBody ? result.page : { ...result.page, body: current.body },
        );
      } catch (failure) {
        report(failure);
      }
    },
    [questionId, report],
  );

  /**
   * Something landed on this notebook, or an edge with an end on it was made (`P06`, `E01`).
   *
   * A drop is ingested in the main process — the preload is the only place that can turn a
   * dropped `File` into a path — and a send may come from a reader in another panel, so the
   * page hears about both the same way it would hear about a change made in another window.
   * Both now *write blocks into the markdown*, which is what retiring the desk means: there is
   * no second surface to grow a card on, so the page re-reads its body and the editor merges
   * the new blocks with whatever is unsaved rather than replacing it.
   */
  useEffect(() => {
    return subscribe('notebook:changed', (payload) => {
      if (payload.questionId !== questionId) return;
      if (payload.reason === 'deleted') {
        // Re-read rather than guess at the message: `load()` asks for a notebook that is not
        // there and shows what the main process says about it, which is the one answer this
        // page and every other reader of a missing row give (`I01`).
        void load();
        return;
      }
      if (payload.reason === 'drop') {
        if (payload.added === 0) {
          store.setStatus('Nothing this notebook can hold was in that drop.', 'error');
          return;
        }
        void reload(true);
        return;
      }
      // `attach` wrote a block; `link` did not, and its page may be mid-paragraph.
      void reload(payload.reason === 'attach');
    });
  }, [load, questionId, reload, store]);

  /**
   * Write the page, and answer with what was stored — which is what the editor re-parses its
   * blocks from, so the document stays the authority.
   */
  const commitBody = useCallback(
    async (body: string): Promise<string> => {
      const parsed = QuestionIdSchema.safeParse(questionId);
      if (!parsed.success) return body;
      try {
        const result = await call('question:writeNotebook', { questionId: parsed.data, body });
        show(result.page);
        setSaved(true);
        return result.page.body;
      } catch (failure) {
        report(failure);
        return body;
      }
    },
    [questionId, report, show],
  );

  /**
   * A highlight, inserted where the researcher is writing (`S03`).
   *
   * The excerpt is markdown — a blockquote and an `annotation://` link — so it is still there
   * for search, for the librarian and for anyone reading the file in a text editor. The typed
   * edge is created alongside it, because quoting a sentence in a notebook *is* the notebook
   * referring to that highlight, and the graph and the ledger both read edges.
   *
   * `landsAsBlock: false` is the one thing worth reading twice. Since `P06` an attach writes
   * the block itself, which is exactly right for a send from a reader — but here the page is
   * already writing it, *open, where the caret is*, which is the whole point of quoting a
   * sentence into prose. Without the flag the researcher would get their quote twice: once
   * where they are typing and once at the end of the document.
   */
  const insertExcerpt = useCallback(
    async (excerpt: { readonly annotationId: string; readonly source: string }) => {
      setPicking(null);
      const parsed = QuestionIdSchema.safeParse(questionId);
      if (!parsed.success) return;
      try {
        await call('question:attach', {
          questionId: parsed.data,
          targetType: 'annotation',
          targetId: excerpt.annotationId,
          landsAsBlock: false,
        });
      } catch (failure) {
        // The edge is the durable half and the quote is the readable one; a duplicate edge
        // must not cost the researcher the paragraph they asked for.
        report(failure);
      }
      // `insertHere`, not `insert` (`S08`): a quote goes after the paragraph the researcher was
      // writing, which is where they meant it, and only at the end when they have not written
      // anywhere yet.
      editor.current?.insertHere(excerpt.source);
    },
    [questionId, report],
  );

  /** Front matter is the notebook's own row, so it goes through the channel the lists use. */
  const patch = useCallback(
    async (change: {
      description?: string | null;
      nextAction?: string | null;
      importance?: number | null;
      tags?: string[];
    }) => {
      const parsed = QuestionIdSchema.safeParse(questionId);
      if (!parsed.success) return;
      try {
        await call('question:update', { questionId: parsed.data, ...change });
      } catch (failure) {
        report(failure);
      } finally {
        await load();
      }
    },
    [load, questionId, report],
  );

  const addClaim = useCallback(async () => {
    const parsed = QuestionIdSchema.safeParse(questionId);
    const statement = claim.trim();
    if (!parsed.success || statement === '') return;
    try {
      await call('hypothesis:create', { questionId: parsed.data, statement });
      setClaim('');
    } catch (failure) {
      report(failure);
    } finally {
      await load();
    }
  }, [claim, load, questionId, report]);

  const setClaimStatus = useCallback(
    async (hypothesisId: string, status: HypothesisStatus) => {
      const parsed = HypothesisIdSchema.safeParse(hypothesisId);
      if (!parsed.success) return;
      try {
        await call('hypothesis:update', { hypothesisId: parsed.data, status });
      } catch (failure) {
        report(failure);
      } finally {
        await load();
      }
    },
    [load, report],
  );

  // The page's headings, read the way its language writes them (`S04`). A Typst page's `=`
  // is not markdown's `#`, so a shared parser would report an outline of nothing.
  const outline = useMemo(() => {
    const body = page?.body ?? '';
    if (page?.bodyFormat !== 'typst') return notebookSections(body);
    return typstSections(body).map((section) => ({ ...section, slug: '' }));
  }, [page]);

  /**
   * Go to a section of the paper (`S01`).
   *
   * The margin listed the page's headings and did nothing with them, which is a table of
   * contents for a document you still have to scroll by hand — fine for four template headings
   * and useless at the length this page is meant to reach.
   *
   * Addressed by *ordinal*, not by slug: every block renders through its own `renderMarkdown`
   * call, so two blocks whose headings read the same are each slugged `method` while
   * `notebookSections` — one slugger over the whole document — calls the second one `method-1`.
   * The one thing both agree on is the order they appear in, and `notebookSections` reports
   * only the top depth, so the nth heading of that depth in the page is the nth entry here.
   * Scoped to this panel's own element because two notebooks can be open at once.
   */
  const pageRef = useRef<HTMLDivElement | null>(null);

  /**
   * Where the live render goes, from the shape of this panel (`S07`).
   *
   * Measured with a `ResizeObserver` rather than a media query, the way `graph-canvas.tsx`
   * measures: the rule is about *this panel*, and a query about the window answers the wrong
   * question the moment a second tab is docked beside it.
   */
  const [placement, setPlacement] = useState<LiveRenderPlacement>('none');
  const [renderWidth, setRenderWidth] = useState(480);
  const [stacked, setStacked] = useState<'below' | 'top' | 'off'>('below');
  useEffect(() => {
    void call('typst:getSettings', {})
      .then((answer) => setStacked(answer.settings.stackedPlacement))
      .catch(() => {
        // The default is what the schema says; a preference that would not load is not an error
        // the researcher can do anything about.
      });
  }, []);
  useLayoutEffect(() => {
    const element = pageRef.current;
    if (element === null) return undefined;
    const measure = (): void => {
      const box = element.getBoundingClientRect();
      setPlacement(liveRenderPlacement(box.width, box.height, stacked));
      // Points, and a share of the panel: a page typeset to the whole width would be a page
      // the writing had to squeeze past.
      setRenderWidth(Math.max(120, Math.round(box.width * 0.42)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [stacked]);

  const headingOffset = page?.bodyFormat === 'typst' ? TYPST_HEADING_TAG_OFFSET : 0;
  const goToSection = useCallback(
    (depth: number, ordinal: number) => {
      const blocks = pageRef.current?.querySelector('[data-testid="notebook-blocks"]');
      const heading = blocks?.querySelectorAll(`h${String(depth + headingOffset)}`)[ordinal];
      heading?.scrollIntoView({ block: 'start' });
    },
    [headingOffset],
  );

  /**
   * Go to one of the page's own sections (`P10`).
   *
   * The same gesture as `goToSection` one level up: front matter, the outline, the writing and
   * the claims are parts of one scrolling document now rather than a margin beside it, so the
   * way to reach them is the way you reach a heading — you scroll there. Scoped to this
   * panel's element for the same reason: two notebooks can be open at once.
   */
  const goToPart = useCallback((part: string) => {
    // A jump to a folded section unfolds it. The alternative is a control that scrolls to a
    // heading with nothing under it, which reads as the jump strip being broken.
    setFolded((current) => {
      if (!current.has(part)) return current;
      const next = new Set(current);
      next.delete(part);
      return next;
    });
    requestAnimationFrame(() => {
      pageRef.current
        ?.querySelector(`[data-testid="notebook-section-${part}"]`)
        ?.scrollIntoView({ block: 'start' });
    });
  }, []);

  const isFolded = (part: string): boolean => folded.has(part);
  const toggleFold = (part: string): void => {
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(part)) next.add(part);
      return next;
    });
  };

  if (error !== null) return <ErrorState message={error} testId="notebook-error" />;
  if (page === null) return <EmptyState message="Opening the page…" testId="notebook-loading" />;

  const notebook = page.question;

  return (
    <div
      className="wr-notebook"
      data-testid="notebook-panel"
      data-question-id={notebook.id}
      ref={pageRef}
    >
      {/* The one thing that does not scroll: whose page this is, and the way back to each of
          its parts. A jump strip rather than a margin (`P10`) — the sections are *in* the
          document, and this is the table of contents for the document itself. */}
      <header className="wr-notebook__head" data-testid="notebook-head">
        {notebook.coverFileId !== null && (
          <img
            className="wr-notebook__cover"
            src={`rrfile://${notebook.coverFileId}`}
            alt=""
            data-testid="notebook-cover"
          />
        )}
        <div className="wr-notebook__heading">
          <h2 className="wr-notebook__title" data-testid="notebook-question-title">
            {notebook.title}
          </h2>
          <span className="wr-notebook__status" data-testid="notebook-status">
            {notebook.status}
            {notebook.startedAt !== null && ` · started ${localDay(notebook.startedAt)}`}
          </span>
        </div>
        {saved && (
          <span className="wr-notebook__saved" data-testid="notebook-saved">
            Saved
          </span>
        )}
        {/* The other half of the notebook (`P02`): the days it was worked on. The directory
            row has both doors and this page had none, so the log was reachable from the
            shelf and not from the page it belongs to. The same command that row runs. */}
        <button
          type="button"
          className="wr-button"
          data-testid="notebook-open-journal"
          onClick={() => void run(COMMAND_IDS.openJournal, { questionId: notebook.id })}
        >
          Journal
        </button>
      </header>

      <nav
        className="wr-notebook__jump"
        aria-label="Parts of this page"
        data-testid="notebook-jump"
        data-control="notebook.jump"
      >
        {[
          ['front-matter', 'Front matter'],
          ['sections', 'Sections'],
          ['writing', 'The paper'],
          ['hypotheses', 'Hypotheses'],
        ].map(([part, label]) => (
          <button
            key={part}
            type="button"
            className="wr-button wr-button--quiet"
            data-testid={`notebook-jump-${String(part)}`}
            onClick={() => goToPart(String(part))}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* One scrolling document. Everything below is a section of it, in the order a paper is
          read: what this is about, what is in it, the paper itself, and what it argues. */}
      <div className="wr-notebook__page" data-testid="notebook-page">
        <section
          className="wr-notebook__section"
          data-testid="notebook-section-front-matter"
          aria-label="Front matter"
          data-folded={isFolded('front-matter') ? 'true' : 'false'}
        >
          <SectionHead
            part="front-matter"
            label="Front matter"
            folded={isFolded('front-matter')}
            onToggle={() => toggleFold('front-matter')}
          />
          {!isFolded('front-matter') && (
          <div className="wr-notebook__front-matter">
            <label className="wr-notebook__field">
              <span>Description</span>
              <input
                className="wr-input"
                type="text"
                placeholder="What is this about, in a sentence?"
                data-testid="notebook-description"
                defaultValue={notebook.description ?? ''}
                key={`description-${notebook.updatedAt}`}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (value !== (notebook.description ?? '')) {
                    void patch({ description: value === '' ? null : value });
                  }
                }}
              />
            </label>
            <label className="wr-notebook__field">
              <span>Next action</span>
              <input
                className="wr-input"
                type="text"
                placeholder="The next concrete step"
                data-testid="notebook-next-action"
                defaultValue={notebook.nextAction ?? ''}
                key={`next-${notebook.updatedAt}`}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (value !== (notebook.nextAction ?? '')) {
                    void patch({ nextAction: value === '' ? null : value });
                  }
                }}
              />
            </label>
            <label className="wr-notebook__field">
              <span>Tags</span>
              <input
                className="wr-input"
                type="text"
                placeholder="comma, separated"
                data-testid="notebook-tags"
                defaultValue={notebook.tags.join(', ')}
                key={`tags-${notebook.updatedAt}`}
                onBlur={(event) => {
                  const next = parseTags(event.target.value);
                  if (next.join(', ') !== notebook.tags.join(', ')) void patch({ tags: next });
                }}
              />
            </label>
            {/* The two headers a Typst page compiles against (`S05`). Here rather than in a
                settings window because they are part of *this page's* front matter: what its
                commands mean is as much a fact about the paper as its tags are. A markdown
                notebook shows nothing — it has no compiler to define anything for. */}
            {page.bodyFormat === 'typst' && (
              <TypstHeaders
                questionId={notebook.id}
                localHeader={page.typstHeader}
                onLocalSaved={() => void reload(false)}
              />
            )}
          </div>
          )}
        </section>

        {/* Derived from the page's own headings, never stored: an outline kept beside the
            document is a second copy of the same fact, and the one that got edited wins by
            accident. */}
        <section
          className="wr-notebook__section"
          data-testid="notebook-section-sections"
          aria-label="Sections"
          data-folded={isFolded('sections') ? 'true' : 'false'}
        >
          <SectionHead
            part="sections"
            label="Sections"
            folded={isFolded('sections')}
            onToggle={() => toggleFold('sections')}
          />
          {!isFolded('sections') && (
          <ul
            className="wr-notebook__outline"
            data-testid="notebook-outline"
            data-control="notebook.outline"
          >
            {outline.length === 0 && (
              <li className="wr-commands__empty" data-testid="notebook-outline-empty">
                Headings in the page show up here.
              </li>
            )}
            {outline.map((section, index) => {
              // The prose above the first heading is a section of the page with no heading to
              // go to, so it is named and left inert rather than offered as a dead control.
              if (section.heading === '') {
                return (
                  <li key={`preamble-${String(index)}`} className="wr-notebook__outline-untitled">
                    (untitled)
                  </li>
                );
              }
              const ordinal = outline
                .slice(0, index)
                .filter((earlier) => earlier.heading !== '').length;
              return (
                <li key={`${section.heading}-${String(index)}`}>
                  <button
                    type="button"
                    className="wr-button wr-button--quiet wr-notebook__outline-link"
                    title="Go to this section of the page"
                    data-testid={`notebook-outline-${String(ordinal)}`}
                    onClick={() => goToSection(section.depth, ordinal)}
                  >
                    {section.heading}
                  </button>
                </li>
              );
            })}
          </ul>
          )}
        </section>

        {/* The writing surface. It is the point of the page and it takes the room (`S01`):
            the sections around it are as tall as their contents and this one grows. */}
        <section
          className="wr-notebook__section wr-notebook__writing"
          data-testid="notebook-section-writing"
          aria-label="The paper"
          data-folded={isFolded('writing') ? 'true' : 'false'}
        >
          <SectionHead
            part="writing"
            label="The paper"
            folded={isFolded('writing')}
            onToggle={() => toggleFold('writing')}
          />
          {!isFolded('writing') && (
          <div
            className={`wr-notebook__writing-area wr-notebook__writing-area--${placement}`}
            data-testid="notebook-writing-area"
            // Where the render went, including `none`. Said out loud because "the panel is the
            // wrong shape for one" is an answer, and a test that could only see the render when
            // there was one could not tell it apart from a render that failed to appear.
            data-render-placement={placement}
          >
            {placement === 'above' && (
              <LiveRender
                questionId={notebook.id}
                body={page.body}
                placement="above"
                widthPt={renderWidth}
              />
            )}
            <div className="wr-notebook__writing-blocks">
              <BlockEditor
                ref={editor}
                surfaceId={`notebook:${notebook.id}`}
                language={page.bodyFormat}
                questionId={notebook.id}
                value={page.body}
                onCommit={commitBody}
                testIdPrefix="notebook"
                ariaLabel={(index) => `Block ${String(index + 1)} of the page for ${notebook.title}`}
                emptyMessage="This page is empty. Write a section, paste some maths, drop in a figure, or quote a highlight."
                saveLabel="Save page"
                dropAttribute={{ name: DROP_NOTEBOOK_PAGE_ATTRIBUTE, value: notebook.id }}
                onPickImage={() => setPicking('image')}
                onPickExcerpt={() => setPicking('excerpt')}
                extraControls={
                  <button
                    type="button"
                    className="wr-button"
                    data-testid="notebook-add-excerpt"
                    data-control="notebook.excerpt"
                    onClick={() => setPicking('excerpt')}
                  >
                    + excerpt
                  </button>
                }
              />
            </div>
            {(placement === 'right' || placement === 'below') && (
              <LiveRender
                questionId={notebook.id}
                body={page.body}
                placement={placement}
                widthPt={renderWidth}
              />
            )}
          </div>
          )}
        </section>

        <section
          className="wr-notebook__section wr-notebook__claims"
          data-testid="notebook-section-hypotheses"
          aria-label="Hypotheses"
          data-folded={isFolded('hypotheses') ? 'true' : 'false'}
        >
          <SectionHead
            part="hypotheses"
            label="Hypotheses"
            count={page.hypotheses.length}
            folded={isFolded('hypotheses')}
            onToggle={() => toggleFold('hypotheses')}
          />
          {!isFolded('hypotheses') && (
          <>
          <ul className="wr-notebook__hypotheses" data-testid="notebook-hypotheses">
            {page.hypotheses.map((hypothesis) => (
              <li
                key={hypothesis.id}
                className="wr-notebook__hypothesis"
                data-testid={`notebook-hypothesis-${hypothesis.id}`}
              >
                <span className="wr-notebook__statement">{hypothesis.statement}</span>
                <select
                  className="wr-input wr-notebook__claim-status"
                  aria-label={`Status of “${hypothesis.statement}”`}
                  data-testid={`notebook-hypothesis-status-${hypothesis.id}`}
                  value={hypothesis.status}
                  onChange={(event) => {
                    const chosen = event.target.value as HypothesisStatus;
                    void setClaimStatus(hypothesis.id, chosen);
                  }}
                >
                  {HYPOTHESIS_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
                <div className="wr-notebook__evidence">
                  <span className="wr-notebook__side-label">For</span>
                  <Citations
                    links={hypothesis.supporting}
                    side="supporting"
                    hypothesisId={hypothesis.id}
                  />
                  <span className="wr-notebook__side-label">Against</span>
                  <Citations
                    links={hypothesis.opposing}
                    side="opposing"
                    hypothesisId={hypothesis.id}
                  />
                </div>
              </li>
            ))}
          </ul>
          <div className="wr-notebook__add-claim">
            <input
              className="wr-input"
              type="text"
              placeholder="What do you think is going on?"
              aria-label="New hypothesis"
              data-testid="notebook-new-hypothesis"
              value={claim}
              onChange={(event) => setClaim(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void addClaim();
              }}
            />
            <button
              type="button"
              className="wr-button"
              data-testid="notebook-add-hypothesis"
              data-control="notebook.claim"
              disabled={claim.trim() === ''}
              onClick={() => void addClaim()}
            >
              Add hypothesis
            </button>
          </div>
          </>
          )}
        </section>
      </div>

      {picking === 'excerpt' && (
        <ExcerptPicker
          onChoose={insertExcerpt}
          onDismiss={() => setPicking(null)}
          format={page.bodyFormat}
        />
      )}
      {picking === 'image' && (
        <PicturePicker
          onChoose={(picture) => {
            setPicking(null);
            // The page's own language decides the spelling; the file id is the same either way,
            // and it is the only thing this side of the app ever holds about the bytes.
            editor.current?.insertHere(
              page.bodyFormat === 'typst'
                ? imageTypst({ fileId: picture.fileId, alt: picture.title })
                : `![${picture.title}](rrfile://${picture.fileId})`,
            );
          }}
          onDismiss={() => setPicking(null)}
        />
      )}
    </div>
  );
}

export function NotebookPanel({ api, params }: DockPanelProps): JSX.Element {
  const descriptor = usePanelDescriptor(params.panelId, 'notebook');
  const onTitle = useCallback((title: string) => api.setTitle(title), [api]);
  if (descriptor === null) {
    return (
      <EmptyState
        message="Open a notebook from the directory to work on its page."
        testId="notebook-panel-empty"
      />
    );
  }
  return <NotebookView questionId={descriptor.questionId} onTitle={onTitle} />;
}
