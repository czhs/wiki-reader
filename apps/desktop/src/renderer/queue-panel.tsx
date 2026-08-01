/**
 * What next: the notebooks in front, in the order they were put in (criterion Q02).
 *
 * The list is dragged by hand and nothing here ever re-sorts it. That is the whole point of
 * the panel: the arrangement is a judgement about what to do next, so a view that quietly
 * sorted by date or by importance would throw away the only thing the researcher expressed.
 * The order rendered is the order the main process returned, and a drag ends by sending the
 * new order back — the view never keeps an arrangement the database has not accepted.
 *
 * It is the short list, not the shelf. Every notebook there is lives on the directory page
 * (`P01`); this is the handful the researcher is choosing between today.
 *
 * Reordering has two ways in, because a grip you can only drag is a grip some people cannot
 * use: pointer-drag, and the arrow keys while the grip has focus. Both go through
 * `moveWithin` and both commit the same way.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import { COMMAND_IDS } from '@wr/workbench';
import { QuestionIdSchema, type Question, type QuestionStatus } from '@wr/shared-types';
import { useOpenContextMenu } from './context-menu.js';
import { call, describeError } from './ipc.js';
import { useWorkspace } from './workspace.js';

/** Move one item, keeping everything else in its relative order. */
export function moveWithin<T>(items: readonly T[], from: number, to: number): T[] {
  const moved = [...items];
  if (from < 0 || from >= moved.length) return moved;
  const clamped = Math.max(0, Math.min(moved.length - 1, to));
  const [item] = moved.splice(from, 1);
  if (item === undefined) return moved;
  moved.splice(clamped, 0, item);
  return moved;
}

const isWorking = (notebook: Question): boolean => notebook.status !== 'discarded';

/** `N·01`, `N·02`… — a stable handle for a notebook in conversation and in a test. */
const positionCode = (index: number): string => `N·${String(index + 1).padStart(2, '0')}`;

export function QueueView({ testId }: { readonly testId?: string }): JSX.Element {
  const { store, workbench } = useWorkspace();
  const openMenu = useOpenContextMenu();
  const [questions, setQuestions] = useState<readonly Question[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  /** Which discarded notebook is being asked about before it is destroyed (`I01`). */
  const [deleting, setDeleting] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const dragging = useRef<string | null>(null);
  /**
   * The order currently on screen, mirrored outside React state.
   *
   * A drag is a stream of pointer events and the drop has to commit exactly what the last
   * move left on screen, so the order is computed here and handed to `setQuestions` — rather
   * than computed inside a state updater, which React is free to run twice.
   */
  const shown = useRef<readonly Question[] | null>(null);

  const show = useCallback((next: readonly Question[]) => {
    shown.current = next;
    setQuestions(next);
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await call('question:list', {});
      show(result.questions);
      setError(null);
    } catch (failure) {
      setError(describeError(failure).message);
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  const report = useCallback(
    (failure: unknown) => {
      store.setStatus(describeError(failure).message, 'error');
    },
    [store],
  );

  /** Send the working list's new order, then take back what the database says it is. */
  const commit = useCallback(
    async (ordered: readonly Question[]) => {
      const ids = ordered.filter(isWorking).map((question) => question.id);
      if (ids.length === 0) return;
      try {
        await call('question:reorder', { questionIds: ids });
      } catch (failure) {
        report(failure);
      } finally {
        await load();
      }
    },
    [load, report],
  );

  // --- pointer drag -------------------------------------------------------
  // The row under the pointer is found from the rendered boxes rather than from a drop
  // target, so the list reorders as the pointer passes each midpoint and what is on screen
  // during the drag is what will be committed.
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, id: string) => {
      event.preventDefault();
      dragging.current = id;
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent): void => {
        const held = dragging.current;
        const current = shown.current;
        if (held === null || current === null) return;
        const from = current.findIndex((question) => question.id === held);
        if (from === -1) return;
        let landing = from;
        for (const question of current) {
          if (!isWorking(question) || question.id === held) continue;
          const element = rows.current.get(question.id);
          if (element === undefined) continue;
          const box = element.getBoundingClientRect();
          const index = current.findIndex((candidate) => candidate.id === question.id);
          if (moveEvent.clientY < box.top + box.height / 2) {
            landing = Math.min(landing, index);
          } else {
            landing = Math.max(landing, index);
          }
        }
        if (landing !== from) show(moveWithin(current, from, landing));
      };

      const onUp = (): void => {
        dragging.current = null;
        if (target.hasPointerCapture(event.pointerId)) {
          target.releasePointerCapture(event.pointerId);
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const current = shown.current;
        if (current !== null) void commit(current);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [commit, show],
  );

  const onGripKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const current = shown.current;
      if (current === null) return;
      const from = current.findIndex((question) => question.id === id);
      if (from === -1) return;
      const next = moveWithin(current, from, event.key === 'ArrowUp' ? from - 1 : from + 1);
      show(next);
      void commit(next);
    },
    [commit, show],
  );

  /** Open a question's page. Through the command registry, like every other panel move. */
  const openNotebook = useCallback(
    async (id: string) => {
      await workbench.commands.execute(
        COMMAND_IDS.openNotebook,
        { questionId: id },
        workbench.context(),
      );
    },
    [workbench],
  );

  // --- editing ------------------------------------------------------------
  const add = useCallback(async () => {
    const title = draft.trim();
    if (title === '') return;
    try {
      await call('question:create', { title });
      setDraft('');
    } catch (failure) {
      report(failure);
    } finally {
      await load();
    }
  }, [draft, load, report]);

  const setStatus = useCallback(
    async (id: string, status: QuestionStatus) => {
      const parsed = QuestionIdSchema.safeParse(id);
      if (!parsed.success) return;
      try {
        await call('question:update', { questionId: parsed.data, status });
      } catch (failure) {
        report(failure);
      } finally {
        await load();
      }
    },
    [load, report],
  );

  const discard = useCallback(
    async (id: string) => {
      const parsed = QuestionIdSchema.safeParse(id);
      if (!parsed.success || reason.trim() === '') return;
      try {
        await call('question:discard', { questionId: parsed.data, reason: reason.trim() });
        setDiscarding(null);
        setReason('');
      } catch (failure) {
        report(failure);
      } finally {
        await load();
      }
    },
    [load, reason, report],
  );

  /**
   * Delete a discarded notebook for good (`I01`).
   *
   * Reported in what was lost rather than as "done": the researcher is entitled to know that
   * eleven days of journal went with the notebook, and the only moment that number can be
   * useful is the moment after it stops existing.
   */
  const destroy = useCallback(
    async (id: string, title: string) => {
      const parsed = QuestionIdSchema.safeParse(id);
      if (!parsed.success) return;
      try {
        const { removed } = await call('question:delete', { questionId: parsed.data });
        setDeleting(null);
        const parts = [
          `${String(removed.journalDays)} ${removed.journalDays === 1 ? 'day' : 'days'} of journal`,
          `${String(removed.cards)} ${removed.cards === 1 ? 'card' : 'cards'}`,
          `${String(removed.links)} ${removed.links === 1 ? 'link' : 'links'}`,
        ];
        store.setStatus(`Deleted “${title}” — ${parts.join(', ')} went with it.`);
      } catch (failure) {
        report(failure);
      } finally {
        await load();
      }
    },
    [load, report, store],
  );

  if (error !== null) return <ErrorState message={error} testId={testId} />;
  if (questions === null) return <EmptyState message="Loading the queue…" testId={testId} />;

  const working = questions.filter(isWorking);
  const discarded = questions.filter((question) => !isWorking(question));

  return (
    <div className="wr-sidebar-body" data-testid={testId}>
      <div className="wr-queue-add">
        <input
          className="wr-input"
          type="text"
          placeholder="What are you working on?"
          aria-label="New notebook"
          data-testid="queue-new-title"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add();
          }}
        />
        <button
          type="button"
          className="wr-button"
          data-testid="queue-add"
          disabled={draft.trim() === ''}
          onClick={() => void add()}
        >
          New notebook
        </button>
      </div>

      {working.length === 0 ? (
        <div className="wr-state" data-testid="queue-empty">
          <p className="wr-state__message">Nothing in front of you yet.</p>
          <p className="wr-state__hint">
            This list is arranged by hand — drag a notebook by its grip to say what comes next.
          </p>
        </div>
      ) : (
        <ol className="wr-queue" data-testid="queue-list">
          {working.map((question, index) => (
            <li
              key={question.id}
              className={
                question.status === 'active' ? 'wr-queue__row wr-queue__row--active' : 'wr-queue__row'
              }
              data-testid={`queue-item-${question.id}`}
              data-question-id={question.id}
              data-position={String(index)}
              onContextMenu={(event) => {
                openMenu(event, 'notebook', { questionId: question.id });
              }}
              ref={(element) => {
                if (element === null) rows.current.delete(question.id);
                else rows.current.set(question.id, element);
              }}
            >
              <button
                type="button"
                className="wr-queue__grip"
                aria-label={`Reorder ${question.title}`}
                title="Drag, or use the arrow keys, to reorder"
                data-testid={`queue-grip-${question.id}`}
                onPointerDown={(event) => onPointerDown(event, question.id)}
                onKeyDown={(event) => onGripKeyDown(event, question.id)}
              >
                ⠿
              </button>
              <span className="wr-queue__code" data-testid={`queue-code-${question.id}`}>
                {positionCode(index)}
              </span>
              <div className="wr-queue__body">
                {/* The title itself is the door to its page (N08). A notebook reachable
                    only by knowing a command is a notebook nobody has. */}
                <button
                  type="button"
                  className="wr-queue__title"
                  title="Open this notebook"
                  data-testid={`queue-open-${question.id}`}
                  onClick={() => void openNotebook(question.id)}
                >
                  {question.title}
                </button>
                {question.description !== null && (
                  <span className="wr-queue__description">{question.description}</span>
                )}
                {question.nextAction !== null && (
                  <span className="wr-queue__next">{question.nextAction}</span>
                )}
                {question.tags.length > 0 && (
                  <span className="wr-queue__tags" data-testid={`queue-tags-${question.id}`}>
                    {question.tags.join(' · ')}
                  </span>
                )}
              </div>
              {/* The state and the two things you can do about it, together, so they wrap
                  under the title as one block instead of each stealing width from it. This
                  list lives in a 280px sidebar; three separate columns left the title a
                  single character wide and it wrapped down the panel one letter per line. */}
              <div className="wr-queue__aside">
                <span
                  className="wr-queue__status"
                  data-testid={`queue-status-${question.id}`}
                >
                  {question.status}
                </span>
                <button
                  type="button"
                  className="wr-button wr-button--quiet"
                  data-testid={`queue-toggle-${question.id}`}
                  onClick={() =>
                    void setStatus(question.id, question.status === 'active' ? 'queued' : 'active')
                  }
                >
                  {question.status === 'active' ? 'Park' : 'Start'}
                </button>
                <button
                  type="button"
                  className="wr-button wr-button--quiet"
                  data-testid={`queue-discard-${question.id}`}
                  onClick={() => {
                    setDiscarding(question.id);
                    setReason('');
                  }}
                >
                  Discard…
                </button>
              </div>
              {discarding === question.id && (
                <div className="wr-queue__discard" data-testid={`queue-discard-form-${question.id}`}>
                  {/* The reason is not optional, and the button says so by staying disabled:
                      a line of work dropped for no recorded reason is the one you start
                      again in six months. */}
                  <input
                    className="wr-input"
                    type="text"
                    placeholder="Why are you dropping it?"
                    aria-label={`Reason for discarding ${question.title}`}
                    data-testid={`queue-discard-reason-${question.id}`}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <button
                    type="button"
                    className="wr-button"
                    data-testid={`queue-discard-confirm-${question.id}`}
                    disabled={reason.trim() === ''}
                    onClick={() => void discard(question.id)}
                  >
                    Discard
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {discarded.length > 0 && (
        <>
          <h3 className="wr-list__section" data-testid="queue-discarded-heading">
            Discarded
            <span className="wr-list__section-count">{discarded.length}</span>
          </h3>
          <ul className="wr-queue wr-queue--discarded" data-testid="queue-discarded-list">
            {discarded.map((question) => (
              <li
                key={question.id}
                className="wr-queue__row wr-queue__row--discarded"
                data-testid={`queue-item-${question.id}`}
                // A set-aside notebook can still be opened and read; restoring it and deleting
                // it stay on the row, where they are guarded and in that order (`I01`).
                onContextMenu={(event) => {
                  openMenu(event, 'notebook', { questionId: question.id });
                }}
              >
                <div className="wr-queue__body">
                  <span className="wr-queue__title">{question.title}</span>
                  {/* The reason is the useful residue of having opened it, so it is shown
                      rather than filed away behind a click. */}
                  <span
                    className="wr-queue__reason"
                    data-testid={`queue-reason-${question.id}`}
                  >
                    {question.discardedReason ?? ''}
                  </span>
                </div>
                {/* The two things that can happen to a set-aside notebook, side by side, so
                    which one is which is legible before either is pressed. Delete is offered
                    *only* here: discarding is reversible and keeps the reason, and an
                    irreversible act one click from a reversible one on the same row is how
                    work gets lost. The main process enforces the same order. */}
                <button
                  type="button"
                  className="wr-button wr-button--quiet"
                  data-testid={`queue-restore-${question.id}`}
                  onClick={() => void setStatus(question.id, 'queued')}
                >
                  Restore
                </button>
                <button
                  type="button"
                  className="wr-button wr-button--quiet wr-button--danger"
                  data-testid={`queue-delete-${question.id}`}
                  onClick={() => setDeleting(question.id)}
                >
                  Delete…
                </button>
                {deleting === question.id && (
                  <div
                    className="wr-queue__delete"
                    data-testid={`queue-delete-form-${question.id}`}
                  >
                    {/* Says what goes and what stays, because "are you sure?" asks a question
                        the researcher cannot answer without knowing that. */}
                    <p className="wr-queue__warning">
                      Delete “{question.title}” for good? Its journal, its claims and its desk go
                      with it. The papers and highlights they pointed at stay in the library.
                    </p>
                    <button
                      type="button"
                      className="wr-button wr-button--danger"
                      data-testid={`queue-delete-confirm-${question.id}`}
                      onClick={() => void destroy(question.id, question.title)}
                    >
                      Delete permanently
                    </button>
                    <button
                      type="button"
                      className="wr-button wr-button--quiet"
                      data-testid={`queue-delete-cancel-${question.id}`}
                      onClick={() => setDeleting(null)}
                    >
                      Keep it
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
