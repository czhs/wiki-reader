/**
 * A field notebook's page (criteria N01, N03, N04, N05, N08).
 *
 * The page is the thing every list in the app points at: prose, the front matter that makes
 * the active list readable, and the claims evidence attaches to. It opens as a tab rather
 * than in a sidebar because it is a page you work on, not a list you consult.
 *
 * Three rules the panel keeps:
 *
 * - **The body is markdown source.** It is edited as source and stored as source; nothing
 *   here renders it on the way in or out. A `contenteditable` storing HTML is the mistake
 *   this design exists to avoid.
 * - **Saving is explicit about having happened.** Prose saves on blur, and the page says so,
 *   because a page that silently discards the last paragraph is worse than one that never
 *   had an editor.
 * - **The cover is a file id.** `rrfile://<id>` is built here; a path never reaches this
 *   process, so there is nothing to build one out of.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { DeskBoard } from './desk-board.js';
import { localDay } from './journal-calendar.js';
import { useWorkspace, useWorkspaceState } from './workspace.js';

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
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);
  const [claim, setClaim] = useState('');

  const report = useCallback(
    (failure: unknown) => {
      store.setStatus(describeError(failure).message, 'error');
    },
    [store],
  );

  const show = useCallback(
    (loaded: NotebookPage) => {
      setPage(loaded);
      setDraft(loaded.body);
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
   * Take the board again, leaving the prose alone.
   *
   * Deliberately not `load()`: the body is a draft the researcher may be halfway through, and
   * a card arriving — dropped, or placed — must not replace what they have typed with what
   * was last saved.
   */
  const reloadBoard = useCallback(async () => {
    const parsed = QuestionIdSchema.safeParse(questionId);
    if (!parsed.success) return;
    try {
      const result = await call('question:notebook', { questionId: parsed.data });
      setPage((current) => (current === null ? result.page : { ...current, cards: result.page.cards }));
    } catch (failure) {
      report(failure);
    }
  }, [questionId, report]);

  /**
   * A file dropped on the board is ingested in the main process, so the page hears about the
   * new card the same way it would hear about one added in another window.
   */
  useEffect(() => {
    return subscribe('notebook:changed', (payload) => {
      if (payload.questionId === questionId) void reloadBoard();
    });
  }, [questionId, reloadBoard]);

  const saveBody = useCallback(async () => {
    const parsed = QuestionIdSchema.safeParse(questionId);
    if (!parsed.success || page === null || draft === page.body) return;
    try {
      const result = await call('question:writeNotebook', { questionId: parsed.data, body: draft });
      show(result.page);
      setSaved(true);
    } catch (failure) {
      report(failure);
    }
  }, [draft, page, questionId, report, show]);

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

  const outline = useMemo(() => notebookSections(draft), [draft]);

  if (error !== null) return <ErrorState message={error} testId="notebook-error" />;
  if (page === null) return <EmptyState message="Opening the page…" testId="notebook-loading" />;

  const notebook = page.question;

  return (
    <div className="wr-notebook" data-testid="notebook-panel" data-question-id={notebook.id}>
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
        {/* The other half of the notebook (`P02`): the days it was worked on. The directory
            row has both doors and this page had none, so the log was reachable from the shelf
            and not from the page it belongs to. The same command that row runs. */}
        <button
          type="button"
          className="wr-button"
          data-testid="notebook-open-journal"
          onClick={() => void run(COMMAND_IDS.openJournal, { questionId: notebook.id })}
        >
          Journal
        </button>
      </header>

      <div className="wr-notebook__front">
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
      </div>

      <section className="wr-notebook__prose">
        <div className="wr-notebook__prose-head">
          <h3 className="wr-list__section">Page</h3>
          {outline.length > 0 && (
            <span className="wr-notebook__outline" data-testid="notebook-outline">
              {outline
                .map((section) => (section.heading === '' ? '(untitled)' : section.heading))
                .join(' · ')}
            </span>
          )}
        </div>
        <textarea
          className="wr-input wr-notebook__body"
          aria-label={`Notebook page for ${notebook.title}`}
          placeholder="What you are after, what is known, what you tried."
          data-testid="notebook-body"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
          onBlur={() => void saveBody()}
        />
        {saved && (
          <span className="wr-notebook__saved" data-testid="notebook-saved">
            Saved
          </span>
        )}
      </section>

      <DeskBoard questionId={notebook.id} cards={page.cards} onChanged={reloadBoard} />

      <section className="wr-notebook__claims">
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
                <span className="wr-notebook__side">For</span>
                <Citations
                  links={hypothesis.supporting}
                  side="supporting"
                  hypothesisId={hypothesis.id}
                />
                <span className="wr-notebook__side">Against</span>
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
            disabled={claim.trim() === ''}
            onClick={() => void addClaim()}
          >
            Add hypothesis
          </button>
        </div>
      </section>
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
