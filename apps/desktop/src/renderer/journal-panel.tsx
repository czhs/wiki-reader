/**
 * A notebook's journal: a page in the workspace, showing one day at a time (N09–N11, P02–P05).
 *
 * It was a sidebar, which sized a day's thinking like a filter; then it was one page for the
 * whole library, which put two lines of thought on the same afternoon. A journal belongs to
 * its notebook (`P02`), so this page is opened *on* one and every read and write here names
 * it. The day's entry takes a reader's width in the centre, with the calendar in the margin
 * where a calendar belongs.
 *
 * The day's entry is a **block notebook** (`N11`), drawn by the shared `BlockEditor` that the
 * notebook's own page also uses (`S01`). Blocks are a view over the day's single markdown
 * document; every commit writes the whole document through `journal:write`. This page owns
 * the document and the round trip, and nothing else about how a block behaves.
 *
 * Three milestone-5 rules the page keeps:
 *
 * - **The calendar begins where the researcher says** (`P03`). The start date is on the page,
 *   beside the days it governs, because it is a fact about this notebook's work.
 * - **A picture dropped on the blocks becomes a block** (`P04`), and its bytes stay where they
 *   were. The drop is handled in the preload and the image is written into the day's markdown
 *   by the main process; this page hears `journal:changed` and re-reads the day.
 * - **A click into a block puts the caret where it landed** (`P05`), not at the start of the
 *   box. The click carries a position; `sourceOffsetFor` maps it from the rendered text back
 *   into the markdown source, and the textarea opens there.
 *
 * Entries save on blur rather than on every keystroke, and an entry cleared to nothing is
 * *deleted* — the same fact the database enforces, surfaced here as the day simply going
 * back to being unlogged.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import { COMMAND_IDS } from '@wr/workbench';
import {
  journalEntityId,
  QuestionIdSchema,
  type JournalEntry,
  type Question,
} from '@wr/shared-types';
import { calendarCells, localDay, type CalendarCell } from './journal-calendar.js';
import { codeBody, parseBlocks } from './block-source.js';
import { BlockEditor, type BlockEditorHandle } from './blocks.js';
import { call, describeError, subscribe } from './ipc.js';
import { useWorkspace, useWorkspaceState } from './workspace.js';

/** Today, as the calendar means it: the local calendar day, not a UTC instant. */
export function todayIso(now: Date = new Date()): string {
  return localDay(now);
}

interface Advance {
  readonly notebookId: string;
  readonly title: string;
}

export function JournalView({
  notebookId,
  testId,
  onTitle,
}: {
  /** Whose log this is. A journal with no notebook is what `P02` retired. */
  readonly notebookId: string;
  readonly testId?: string;
  /** Retitles the tab to the notebook and day being read. */
  readonly onTitle?: (title: string) => void;
}): JSX.Element {
  const { store, run } = useWorkspace();
  const [today] = useState(() => todayIso());
  const [selected, setSelected] = useState(() => todayIso());
  const [logged, setLogged] = useState<readonly string[] | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const editor = useRef<BlockEditorHandle | null>(null);
  const [notebook, setNotebook] = useState<Question | null>(null);
  const [others, setOthers] = useState<readonly Question[]>([]);
  const [advances, setAdvances] = useState<readonly Advance[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Which day the answers coming back belong to. A write and a day switch are two round
  // trips in flight at once — clicking another day blurs the editor, which commits — and the
  // slower one must not drop yesterday's blocks onto today's page.
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const report = useCallback(
    (failure: unknown) => {
      store.setStatus(describeError(failure).message, 'error');
    },
    [store],
  );

  const parsedNotebookId = useMemo(() => {
    const parsed = QuestionIdSchema.safeParse(notebookId);
    return parsed.success ? parsed.data : null;
  }, [notebookId]);

  const loadCalendar = useCallback(async () => {
    if (parsedNotebookId === null) {
      setError('This page is not open on a notebook.');
      return;
    }
    try {
      const result = await call('journal:loggedDates', { notebookId: parsedNotebookId });
      setLogged(result.dates);
      setStart(result.journalStart);
      setError(null);
    } catch (failure) {
      setError(describeError(failure).message);
    }
  }, [parsedNotebookId]);

  const loadDay = useCallback(
    async (date: string) => {
      if (parsedNotebookId === null) return;
      try {
        const [{ entry: found }, { links }] = await Promise.all([
          call('journal:get', { notebookId: parsedNotebookId, date }),
          call('link:findReferences', {
            entityType: 'journal',
            entityId: journalEntityId(parsedNotebookId, date),
            direction: 'outgoing',
          }),
        ]);
        if (selectedRef.current !== date) return;
        setEntry(found);
        setAdvances(
          links
            .filter((link) => link.type === 'journal-entry-advances-question')
            .map((link) => ({ notebookId: link.targetId, title: link.otherTitle })),
        );
      } catch (failure) {
        report(failure);
      }
    },
    [parsedNotebookId, report],
  );

  useEffect(() => {
    void loadCalendar();
    void (async () => {
      if (parsedNotebookId === null) return;
      try {
        const [{ question }, { questions }] = await Promise.all([
          call('question:get', { questionId: parsedNotebookId }),
          call('question:list', { status: ['active', 'queued'] }),
        ]);
        setNotebook(question);
        setOthers(questions.filter((candidate) => candidate.id !== parsedNotebookId));
      } catch {
        // The notebook's own row decorates this page; the day is still writable without it,
        // so a failure here must not take the entry down.
        setOthers([]);
      }
    })();
  }, [loadCalendar, parsedNotebookId]);

  useEffect(() => {
    void loadDay(selected);
  }, [loadDay, selected]);

  /**
   * A picture dropped on the blocks is written into the day by the main process (`P04`), so
   * the page hears about it the way it would hear about an edit made in another window.
   */
  useEffect(() => {
    return subscribe('journal:changed', (payload) => {
      if (payload.notebookId !== parsedNotebookId) return;
      if (payload.date !== selectedRef.current) return;
      if (payload.added === 0) {
        store.setStatus('That was not a picture this notebook can show.', 'error');
        return;
      }
      void loadDay(payload.date);
      void loadCalendar();
    });
  }, [loadCalendar, loadDay, parsedNotebookId, store]);

  useEffect(() => {
    const name = notebook?.title ?? '';
    // The kind first, the notebook second, the day last. A tab strip truncates the tail, and
    // the notebook page's tab is the notebook's own title — so a journal titled
    // "<notebook> — today" arrived on screen as a second tab spelled exactly like the first.
    // Same reasoning as `Focus · <file>` and `Links · <file>`.
    const day = selected === today ? 'today' : selected;
    onTitle?.(name === '' ? `Journal — ${day}` : `Journal · ${name} — ${day}`);
  }, [notebook, onTitle, selected, today]);

  /**
   * Write the day, and answer with what was stored.
   *
   * The markdown is the authority: the editor re-parses the document this returns rather than
   * keeping its own idea of the blocks. A day emptied altogether comes back as no entry at
   * all, which is how the journal deletes a day.
   */
  const commit = useCallback(
    async (markdown: string): Promise<string> => {
      if (parsedNotebookId === null) return markdown;
      const date = selected;
      try {
        const result = await call('journal:write', {
          notebookId: parsedNotebookId,
          date,
          markdown,
        });
        if (selectedRef.current !== date) return markdown;
        setEntry(result.entry);
        await loadCalendar();
        return result.entry?.markdown ?? '';
      } catch (failure) {
        report(failure);
        return markdown;
      }
    },
    [loadCalendar, parsedNotebookId, report, selected],
  );

  const advance = useCallback(
    async (advancesId: string) => {
      const parsed = QuestionIdSchema.safeParse(advancesId);
      if (!parsed.success || parsedNotebookId === null) return;
      try {
        await call('journal:advancesNotebook', {
          notebookId: parsedNotebookId,
          date: selected,
          advancesId: parsed.data,
        });
        await loadDay(selected);
      } catch (failure) {
        report(failure);
      }
    },
    [loadDay, parsedNotebookId, report, selected],
  );

  /** Move where this notebook's calendar begins (`P03`). */
  const setJournalStart = useCallback(
    async (date: string) => {
      if (parsedNotebookId === null) return;
      try {
        const result = await call('question:update', {
          questionId: parsedNotebookId,
          journalStart: date === '' ? null : date,
        });
        setNotebook(result.question);
        // Re-read rather than assume: the answer resolves a cleared date back to the
        // notebook's own beginning, and an entry older than the chosen day still wins.
        await loadCalendar();
      } catch (failure) {
        report(failure);
      }
    },
    [loadCalendar, parsedNotebookId, report],
  );

  /** The day's commands: its code blocks, one line each, in the order they were written. */
  const commands = useMemo(
    () =>
      parseBlocks(entry?.markdown ?? '').flatMap((block, index) => {
        if (block.type !== 'code') return [];
        const text = codeBody(block.src).trim();
        return text === '' ? [] : [{ index, text }];
      }),
    [entry],
  );

  const copyCommand = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        store.setStatus(`Copied ${text}`);
      } catch {
        // Clipboard permission can be refused; the command is on screen either way.
        store.setStatus('Could not copy that command.', 'error');
      }
    },
    [store],
  );

  const cells: CalendarCell[] = useMemo(() => {
    if (logged === null || start === null) return [];
    // Every day from where this notebook's calendar begins (`P03`) to today. A start in the
    // future is a clock disagreement, not a range: fall back to today.
    const from = start > today ? today : start;
    return calendarCells({ from, to: today, today, logged, expanded });
  }, [expanded, start, logged, today]);

  if (error !== null) return <ErrorState message={error} testId={testId} />;
  if (logged === null) return <EmptyState message="Loading the journal…" testId={testId} />;

  const unlinked = others.filter(
    (candidate) => !advances.some((linked) => linked.notebookId === candidate.id),
  );

  return (
    <div
      className="wr-journal-page"
      data-testid={testId ?? 'journal-page'}
      data-notebook-id={notebookId}
    >
      {/* The day's entry is the page: it takes the width, and everything else is margin. */}
      <main className="wr-journal-page__main" data-testid="journal-main">
        <h2 className="wr-journal-page__date" data-testid="journal-selected-date">
          {selected}
          {selected === today && <span className="wr-list__section-count">today</span>}
        </h2>
        {/* Whose log this is, and the way back to it. A journal belongs to a notebook
            (`P02`), and the name of the notebook was printed here as inert text — so the page
            said what it belonged to and offered no way to get there. The same command the
            directory's rows run. */}
        <p className="wr-journal-page__owner">
          <button
            type="button"
            className="wr-button wr-button--quiet"
            title="Open this notebook’s page"
            data-testid="journal-notebook-title"
            disabled={notebook === null}
            onClick={() => void run(COMMAND_IDS.openNotebook, { questionId: notebookId })}
          >
            {notebook?.title ?? ''}
          </button>
        </p>

        <BlockEditor
          ref={editor}
          value={entry?.markdown ?? ''}
          onCommit={commit}
          testIdPrefix="journal"
          ariaLabel={(index) => `Block ${String(index + 1)} of the entry for ${selected}`}
          emptyMessage="Nothing logged on this day. Start with a note, a command you ran, or drop in a picture."
          saveLabel="Save day"
          // The value names the day, and the main process writes the picture into that day's
          // markdown (`P04`). Nothing here ever sees a path.
          dropAttribute={{ name: 'data-wr-drop-journal', value: `${notebookId}:${selected}` }}
        />
      </main>

      <aside className="wr-journal-page__side" data-testid="journal-side">
        <section className="wr-journal-page__section">
          <h3 className="wr-list__section">Days</h3>
          <div className="wr-journal" data-testid="journal-calendar">
            {cells.map((cell) =>
              cell.kind === 'run' ? (
                <button
                  key={`run-${cell.from}`}
                  type="button"
                  className="wr-journal__day wr-journal__day--collapsed"
                  title={`${cell.from} → ${cell.to}`}
                  data-testid={`journal-run-${cell.from}`}
                  onClick={() => setExpanded((current) => [...current, cell.from])}
                >
                  {`· ${String(cell.count)} days ·`}
                </button>
              ) : (
                <button
                  key={cell.date}
                  type="button"
                  className={[
                    'wr-journal__day',
                    cell.logged ? 'wr-journal__day--logged' : '',
                    cell.isToday ? 'wr-journal__day--today' : '',
                    cell.date === selected ? 'wr-journal__day--selected' : '',
                  ]
                    .filter((name) => name !== '')
                    .join(' ')}
                  title={cell.date}
                  aria-pressed={cell.date === selected}
                  data-testid={`journal-day-${cell.date}`}
                  data-logged={cell.logged ? 'true' : 'false'}
                  onClick={() => setSelected(cell.date)}
                >
                  {cell.date.slice(8)}
                </button>
              ),
            )}
          </div>
          {/* Where the calendar begins (`P03`). Beside the days it governs, because that is
              the only place the answer is visible the moment it changes. */}
          <label className="wr-journal__start">
            <span>Begins</span>
            <input
              className="wr-input"
              type="date"
              aria-label="The day this journal begins"
              data-testid="journal-start-date"
              max={today}
              value={notebook?.journalStart ?? ''}
              onChange={(event) => void setJournalStart(event.target.value)}
            />
          </label>
          <span className="wr-journal__start-note" data-testid="journal-start-resolved">
            {start ?? ''}
          </span>
        </section>

        <section className="wr-journal-page__section">
          <h3 className="wr-list__section">Commands</h3>
          {/* Derived, never stored: the commands you jotted today *are* the day's code
              blocks. A second list to keep in step with them would be a second copy of the
              same fact, and the one that got edited would win by accident. */}
          <ul className="wr-commands" data-testid="journal-commands">
            {commands.length === 0 && (
              <li className="wr-commands__empty" data-testid="journal-commands-empty">
                Code blocks in the day show up here.
              </li>
            )}
            {commands.map((command) => (
              <li key={command.index} className="wr-commands__item">
                <button
                  type="button"
                  className="wr-commands__text"
                  title="Go to this block"
                  data-testid={`journal-command-${String(command.index)}`}
                  onClick={() => editor.current?.open(command.index)}
                >
                  {command.text}
                </button>
                <button
                  type="button"
                  className="wr-button wr-button--quiet"
                  title="Copy this command"
                  aria-label={`Copy: ${command.text}`}
                  data-testid={`journal-command-copy-${String(command.index)}`}
                  onClick={() => void copyCommand(command.text)}
                >
                  ⧉
                </button>
              </li>
            ))}
          </ul>
        </section>

        {(advances.length > 0 || unlinked.length > 0) && (
          <section className="wr-journal-page__section">
            <h3 className="wr-list__section">Advances</h3>
            <ul className="wr-journal__advances" data-testid="journal-advances">
              {/* A heading with nothing under it is the reader's problem to solve. Commands
                  says what would appear there; this says the same, and says which of the two
                  reasons it is empty for — nothing written yet, or nothing named yet. */}
              {advances.length === 0 && (
                <li className="wr-commands__empty" data-testid="journal-advances-empty">
                  {entry === null
                    ? 'Write the day first, then name the other notebooks it moved forward.'
                    : 'Name another notebook this day moved forward.'}
                </li>
              )}
              {advances.map((linked) => (
                <li key={linked.notebookId} data-testid={`journal-advance-${linked.notebookId}`}>
                  {linked.title}
                </li>
              ))}
            </ul>
            {entry !== null && unlinked.length > 0 && (
              <div className="wr-journal__link">
                {/* Only offered once the day has an entry: an edge from a day nobody wrote on
                    would point at nothing, and the main process refuses it anyway. The day
                    already belongs to this notebook, so the list is every *other* one. */}
                <select
                  className="wr-input"
                  aria-label="Another notebook this day advances"
                  data-testid="journal-advance-picker"
                  defaultValue=""
                  onChange={(event) => {
                    const chosen = event.target.value;
                    event.target.value = '';
                    if (chosen !== '') void advance(chosen);
                  }}
                >
                  <option value="">Also advances…</option>
                  {unlinked.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}

interface PanelParams {
  readonly panelId: string;
}

export function JournalPanel({ api, params }: IDockviewPanelProps<PanelParams>): JSX.Element {
  const state = useWorkspaceState();
  const descriptor = state.panels[params.panelId] ?? null;
  const onTitle = useCallback((title: string) => api.setTitle(title), [api]);
  if (descriptor === null || descriptor.kind !== 'journal') {
    return (
      <EmptyState
        message="A journal belongs to a notebook. Open one from the directory."
        testId="journal-panel-empty"
      />
    );
  }
  return <JournalView notebookId={descriptor.questionId} onTitle={onTitle} />;
}
