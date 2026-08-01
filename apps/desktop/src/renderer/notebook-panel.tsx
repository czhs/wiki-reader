/**
 * A field notebook's page (criteria N01, N03, N04, N05, N08, S01–S03).
 *
 * This is where the paper gets written. The journal is notes to oneself; the notebook does
 * the heavy lifting, and a full publishable scientific paper has to be writable here —
 * headings and prose, LaTeX, code, pictures, and excerpts that keep their link to what was
 * read. So the page is the **same block editor the journal's day is** (`S01`), and the layout
 * says which of the things on this page is the point: the writing surface takes the room, and
 * the front matter, the claims and the desk are margin.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import { notebookSections } from '@wr/document-model';
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
import { DeskBoard } from './desk-board.js';
import { ExcerptPicker } from './excerpt-picker.js';
import { localDay } from './journal-calendar.js';
import { useWorkspace, useWorkspaceState } from './workspace.js';

/**
 * The attribute the preload's drop listener reads for a picture dropped on the page (`S01`).
 *
 * A sibling of the desk board's `data-wr-drop-question`, never an ancestor of it: `closest`
 * picks the innermost target, so nesting these would take the board's drops away from it.
 */
export const DROP_NOTEBOOK_PAGE_ATTRIBUTE = 'data-wr-drop-notebook-page';

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

export function NotebookView({
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
  const [picking, setPicking] = useState(false);
  const editor = useRef<BlockEditorHandle | null>(null);

  const report = useCallback(
    (failure: unknown) => {
      store.setStatus(describeError(failure).message, 'error');
    },
    [store],
  );

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
   * Take the page again, leaving the prose alone.
   *
   * Deliberately not `load()`: the body is a draft the researcher may be halfway through, and
   * a card arriving — dropped, or placed — must not replace what they have typed with what was
   * last saved. The draft is the *only* thing worth keeping, though. This used to keep `cards`
   * out of the fresh answer and throw the rest of it away, which meant `hypotheses` — where a
   * claim's *For* and *Against* lines live — could not be refreshed at all: evidence linked in
   * the reader beside the page arrived and the page went on showing an empty *For* until it
   * was remounted.
   */
  const reloadBesideTheDraft = useCallback(async () => {
    const parsed = QuestionIdSchema.safeParse(questionId);
    if (!parsed.success) return;
    try {
      const result = await call('question:notebook', { questionId: parsed.data });
      setPage((current) => (current === null ? result.page : { ...result.page, body: current.body }));
    } catch (failure) {
      report(failure);
    }
  }, [questionId, report]);

  /** The page's body again, when the main process was the one that changed it. */
  const reloadBody = useCallback(async () => {
    const parsed = QuestionIdSchema.safeParse(questionId);
    if (!parsed.success) return;
    try {
      const result = await call('question:notebook', { questionId: parsed.data });
      setPage((current) => (current === null ? result.page : { ...current, body: result.page.body }));
    } catch (failure) {
      report(failure);
    }
  }, [questionId, report]);

  /**
   * A file dropped on the board, or a picture dropped on the page, is ingested in the main
   * process — so the page hears about it the same way it would hear about a change made in
   * another window. A picture is a block; the editor merges it with whatever is unsaved
   * rather than replacing it.
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
      if (payload.reason === 'page-drop') {
        if (payload.added === 0) {
          store.setStatus('That was not a picture this notebook can show.', 'error');
          return;
        }
        void reloadBody();
        return;
      }
      void reloadBesideTheDraft();
    });
  }, [load, questionId, reloadBesideTheDraft, reloadBody, store]);

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
   * referring to that highlight, and the desk, the graph and the ledger all read edges.
   */
  const insertExcerpt = useCallback(
    async (excerpt: { readonly annotationId: string; readonly markdown: string }) => {
      setPicking(false);
      const parsed = QuestionIdSchema.safeParse(questionId);
      if (!parsed.success) return;
      try {
        await call('question:attach', {
          questionId: parsed.data,
          targetType: 'annotation',
          targetId: excerpt.annotationId,
        });
      } catch (failure) {
        // The edge is the durable half and the quote is the readable one; a duplicate edge
        // must not cost the researcher the paragraph they asked for.
        report(failure);
      }
      editor.current?.insert(excerpt.markdown);
      await reloadBesideTheDraft();
    },
    [questionId, reloadBesideTheDraft, report],
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

  const outline = useMemo(() => notebookSections(page?.body ?? ''), [page]);

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
  const goToSection = useCallback((depth: number, ordinal: number) => {
    const blocks = pageRef.current?.querySelector('[data-testid="notebook-blocks"]');
    const heading = blocks?.querySelectorAll(`h${String(depth)}`)[ordinal];
    heading?.scrollIntoView({ block: 'start' });
  }, []);

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
      {/* The page is the page: it takes the room, and everything else is margin (`S01`). */}
      <main className="wr-notebook__main" data-testid="notebook-main">
        <header className="wr-notebook__head">
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

        <BlockEditor
          ref={editor}
          surfaceId={`notebook:${notebook.id}`}
          value={page.body}
          onCommit={commitBody}
          testIdPrefix="notebook"
          ariaLabel={(index) => `Block ${String(index + 1)} of the page for ${notebook.title}`}
          emptyMessage="This page is empty. Write a section, paste some maths, drop in a figure, or quote a highlight."
          saveLabel="Save page"
          dropAttribute={{ name: DROP_NOTEBOOK_PAGE_ATTRIBUTE, value: notebook.id }}
          extraControls={
            <button
              type="button"
              className="wr-button"
              data-testid="notebook-add-excerpt"
              data-control="notebook.excerpt"
              onClick={() => setPicking(true)}
            >
              + excerpt
            </button>
          }
        />
      </main>

      <aside className="wr-notebook__side" data-testid="notebook-side">
        <section className="wr-notebook__section">
          <h3 className="wr-list__section">Front matter</h3>
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
        </section>

        {/* Derived from the page's own headings, never stored: an outline kept beside the
            document is a second copy of the same fact, and the one that got edited wins by
            accident. */}
        <section className="wr-notebook__section">
          <h3 className="wr-list__section">Sections</h3>
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
        </section>

        <section className="wr-notebook__section wr-notebook__claims">
          <h3 className="wr-list__section">
            Hypotheses
            <span className="wr-list__section-count">{page.hypotheses.length}</span>
          </h3>
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
        </section>
      </aside>

      {/* The desk is along the bottom rather than in the margin: it is a surface cards are
          dragged on, and a 240px column is not one. */}
      <div className="wr-notebook__desk-row">
        <DeskBoard questionId={notebook.id} cards={page.cards} onChanged={reloadBesideTheDraft} />
      </div>

      {picking && (
        <ExcerptPicker onChoose={insertExcerpt} onDismiss={() => setPicking(false)} />
      )}
    </div>
  );
}

interface PanelParams {
  readonly panelId: string;
}

export function NotebookPanel({ api, params }: IDockviewPanelProps<PanelParams>): JSX.Element {
  const state = useWorkspaceState();
  const descriptor = state.panels[params.panelId] ?? null;
  const onTitle = useCallback((title: string) => api.setTitle(title), [api]);
  if (descriptor === null || descriptor.kind !== 'notebook') {
    return (
      <EmptyState
        message="Open a notebook from the directory to work on its page."
        testId="notebook-panel-empty"
      />
    );
  }
  return <NotebookView questionId={descriptor.questionId} onTitle={onTitle} />;
}
