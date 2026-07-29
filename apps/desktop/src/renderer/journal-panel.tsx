/**
 * The research journal: a page in the workspace, showing one day at a time (N09).
 *
 * It was a sidebar, which sized a day's thinking like a filter — 260px beside the reader,
 * with the entry a four-line textarea at the bottom of a wall of bubbles. The journal is
 * where the day's work is written down, so it belongs in the centre at a reader's width,
 * with the calendar in the margin where a calendar belongs.
 *
 * The calendar's shape comes from `calendarCells`, which is pure and tested on its own — the
 * collapse rule has an off-by-one in it and is worth asserting without a DOM in the way. This
 * component is the part that cannot be tested that way: fetching, typing, and saving.
 *
 * Entries save on blur rather than on every keystroke, and an entry cleared to nothing is
 * *deleted* — the same fact the database enforces, surfaced here as the day simply going
 * back to being unlogged.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import { QuestionIdSchema, type JournalEntry, type Question } from '@wr/shared-types';
import { calendarCells, type CalendarCell } from './journal-calendar.js';
import { call, describeError } from './ipc.js';
import { useWorkspace } from './workspace.js';

/** Today, as the calendar means it: the local calendar day, not a UTC instant. */
export function todayIso(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface Advance {
  readonly questionId: string;
  readonly title: string;
}

export function JournalView({
  testId,
  onTitle,
}: {
  readonly testId?: string;
  /** Retitles the tab to the day being read. */
  readonly onTitle?: (title: string) => void;
}): JSX.Element {
  const { store } = useWorkspace();
  const [today] = useState(() => todayIso());
  const [selected, setSelected] = useState(() => todayIso());
  const [logged, setLogged] = useState<readonly string[] | null>(null);
  const [projectStart, setProjectStart] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [draft, setDraft] = useState('');
  const [questions, setQuestions] = useState<readonly Question[]>([]);
  const [advances, setAdvances] = useState<readonly Advance[]>([]);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback(
    (failure: unknown) => {
      store.setStatus(describeError(failure).message, 'error');
    },
    [store],
  );

  const loadCalendar = useCallback(async () => {
    try {
      const result = await call('journal:loggedDates', {});
      setLogged(result.dates);
      setProjectStart(result.projectStart);
      setError(null);
    } catch (failure) {
      setError(describeError(failure).message);
    }
  }, []);

  const loadDay = useCallback(
    async (date: string) => {
      try {
        const [{ entry: found }, { links }] = await Promise.all([
          call('journal:get', { date }),
          call('link:findReferences', { entityType: 'journal', entityId: date, direction: 'outgoing' }),
        ]);
        setEntry(found);
        setDraft(found?.markdown ?? '');
        setAdvances(
          links
            .filter((link) => link.type === 'journal-entry-advances-question')
            .map((link) => ({ questionId: link.targetId, title: link.otherTitle })),
        );
      } catch (failure) {
        report(failure);
      }
    },
    [report],
  );

  useEffect(() => {
    void loadCalendar();
    void (async () => {
      try {
        const result = await call('question:list', { status: ['active', 'queued'] });
        setQuestions(result.questions);
      } catch {
        // The question picker is an extra on this page; the journal is still writable
        // without it, so a failure here must not take the day's entry down.
        setQuestions([]);
      }
    })();
  }, [loadCalendar]);

  useEffect(() => {
    void loadDay(selected);
  }, [loadDay, selected]);

  useEffect(() => {
    onTitle?.(selected === today ? 'Journal — today' : `Journal — ${selected}`);
  }, [onTitle, selected, today]);

  const save = useCallback(async () => {
    if (draft === (entry?.markdown ?? '')) return;
    try {
      const result = await call('journal:write', { date: selected, markdown: draft });
      setEntry(result.entry);
      // Clearing a day is a real edit: the textarea keeps what the database kept, which for
      // a blank entry is nothing at all.
      setDraft(result.entry?.markdown ?? '');
      await loadCalendar();
    } catch (failure) {
      report(failure);
    }
  }, [draft, entry, loadCalendar, report, selected]);

  const advance = useCallback(
    async (questionId: string) => {
      const parsed = QuestionIdSchema.safeParse(questionId);
      if (!parsed.success) return;
      try {
        await call('journal:advancesQuestion', { date: selected, questionId: parsed.data });
        await loadDay(selected);
      } catch (failure) {
        report(failure);
      }
    },
    [loadDay, report, selected],
  );

  const cells: CalendarCell[] = useMemo(() => {
    if (logged === null) return [];
    // Every day since the project began, whether or not anything was written on it (`N10`).
    // A start in the future is a clock disagreement, not a range: fall back to today.
    const start = projectStart === null || projectStart > today ? today : projectStart;
    return calendarCells({ from: start, to: today, today, logged, expanded });
  }, [expanded, projectStart, logged, today]);

  if (error !== null) return <ErrorState message={error} testId={testId} />;
  if (logged === null) return <EmptyState message="Loading the journal…" testId={testId} />;

  const unlinked = questions.filter(
    (question) => !advances.some((linked) => linked.questionId === question.id),
  );

  return (
    <div className="wr-journal-page" data-testid={testId ?? 'journal-page'}>
      {/* The day's entry is the page: it takes the width, and everything else is margin. */}
      <main className="wr-journal-page__main" data-testid="journal-main">
        <h2 className="wr-journal-page__date" data-testid="journal-selected-date">
          {selected}
          {selected === today && <span className="wr-list__section-count">today</span>}
        </h2>
        <textarea
          className="wr-input wr-journal__text"
          aria-label={`Journal entry for ${selected}`}
          placeholder="What did you do, and what did you learn?"
          data-testid="journal-entry-text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save()}
        />
        <button
          type="button"
          className="wr-button"
          data-testid="journal-save"
          onClick={() => void save()}
        >
          Save entry
        </button>
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
        </section>

        {(advances.length > 0 || unlinked.length > 0) && (
          <section className="wr-journal-page__section">
            <h3 className="wr-list__section">Advances</h3>
            <ul className="wr-journal__advances" data-testid="journal-advances">
              {advances.map((linked) => (
                <li key={linked.questionId} data-testid={`journal-advance-${linked.questionId}`}>
                  {linked.title}
                </li>
              ))}
            </ul>
            {entry !== null && unlinked.length > 0 && (
              <div className="wr-journal__link">
                {/* Only offered once the day has an entry: an edge from a day nobody wrote on
                    would point at nothing, and the main process refuses it anyway. */}
                <select
                  className="wr-input"
                  aria-label="Question this entry advances"
                  data-testid="journal-advance-picker"
                  defaultValue=""
                  onChange={(event) => {
                    const chosen = event.target.value;
                    event.target.value = '';
                    if (chosen !== '') void advance(chosen);
                  }}
                >
                  <option value="">Advances a question…</option>
                  {unlinked.map((question) => (
                    <option key={question.id} value={question.id}>
                      {question.title}
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

export function JournalPanel({ api }: IDockviewPanelProps<PanelParams>): JSX.Element {
  const onTitle = useCallback((title: string) => api.setTitle(title), [api]);
  return <JournalView onTitle={onTitle} />;
}
