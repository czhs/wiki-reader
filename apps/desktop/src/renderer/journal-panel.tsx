/**
 * The research journal: a page in the workspace, showing one day at a time (N09–N11).
 *
 * It was a sidebar, which sized a day's thinking like a filter — 260px beside the reader,
 * with the entry a four-line textarea at the bottom of a wall of bubbles. The journal is
 * where the day's work is written down, so it belongs in the centre at a reader's width,
 * with the calendar in the margin where a calendar belongs.
 *
 * The day's entry is a **block notebook** (`N11`): a sequence of text, code and image blocks
 * you click into one at a time. Blocks are a view over the day's single markdown document —
 * `journal-blocks.ts` parses them out and puts them back, and every commit writes the whole
 * document through `journal:write`. There is no block store, and nothing here executes
 * anything: a code block is a command someone jotted down, kept as the text they typed.
 *
 * Beside it: the calendar, and the day's commands — which are its code blocks, listed rather
 * than stored again.
 *
 * The calendar's shape comes from `calendarCells`, and the block segmentation from
 * `parseBlocks`; both are pure and tested on their own, because that is where the off-by-ones
 * live. This component is the part that cannot be tested that way: fetching, typing, saving.
 *
 * Entries save on blur rather than on every keystroke, and an entry cleared to nothing is
 * *deleted* — the same fact the database enforces, surfaced here as the day simply going
 * back to being unlogged.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { renderMarkdown } from '@wr/markdown-reader';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import { QuestionIdSchema, type JournalEntry, type Question } from '@wr/shared-types';
import { calendarCells, type CalendarCell } from './journal-calendar.js';
import {
  classify,
  codeBody,
  codeLanguage,
  parseBlocks,
  serializeBlocks,
  EMPTY_CODE_BLOCK,
  type Block,
} from './journal-blocks.js';
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

/**
 * A block on screen: what it is, plus a key that survives editing.
 *
 * The key is not the index. Blocks are re-parsed out of the stored markdown after every
 * write, and keying by index makes React reuse the textarea of a block that has become a
 * different one — so the caret lands in the wrong place after an edit that changed how many
 * blocks there are.
 */
interface BlockRow extends Block {
  readonly key: number;
}

let keySeq = 0;
const nextKey = (): number => {
  keySeq += 1;
  return keySeq;
};

const toRows = (blocks: readonly Block[]): BlockRow[] =>
  blocks.map((block) => ({ ...block, key: nextKey() }));

/**
 * One block, rendered.
 *
 * Text and images go through the corpus renderer, which builds React elements from the mdast
 * and never an HTML string, so a day's entry cannot inject markup into the app's origin. An
 * image resolves through `rrfile://` like every other byte — the window's `img-src` allows
 * nothing else, so a pasted remote URL renders as a broken image rather than as a request.
 *
 * Code is drawn here rather than by the renderer because a command is source: it keeps its
 * whitespace, and it is what the commands margin lists.
 */
function BlockBody({ block }: { readonly block: Block }): JSX.Element {
  if (block.type === 'code') {
    const language = codeLanguage(block.src);
    return (
      <pre className="wr-block__code" data-language={language ?? ''}>
        <code>{codeBody(block.src)}</code>
      </pre>
    );
  }
  if (block.src.trim() === '') {
    return <span className="wr-block__placeholder">Empty block</span>;
  }
  return <>{renderMarkdown(block.src)}</>;
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
  const [rows, setRows] = useState<readonly BlockRow[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [questions, setQuestions] = useState<readonly Question[]>([]);
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
        if (selectedRef.current !== date) return;
        setEntry(found);
        setRows(toRows(parseBlocks(found?.markdown ?? '')));
        setEditing(null);
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

  /**
   * Write the day, and take the blocks back from what was stored.
   *
   * The markdown is the authority, so the page re-parses the document the main process
   * answers with rather than keeping its own idea of the blocks. That is what makes the block
   * list a *view*: a block edited into a fence comes back as a code block, a block emptied
   * disappears, and a day emptied altogether comes back as no entry at all.
   */
  const commit = useCallback(async () => {
    setEditing(null);
    const markdown = serializeBlocks(rows);
    if (markdown === (entry?.markdown ?? '')) return;
    const date = selected;
    try {
      const result = await call('journal:write', { date, markdown });
      if (selectedRef.current !== date) return;
      setEntry(result.entry);
      setRows(toRows(parseBlocks(result.entry?.markdown ?? '')));
      await loadCalendar();
    } catch (failure) {
      report(failure);
    }
  }, [entry, loadCalendar, report, rows, selected]);

  /** Add a block at the end and open it: an inserted block is one you are about to type in. */
  const insert = useCallback((src: string) => {
    setRows((current) => {
      setEditing(current.length);
      return [...current, { key: nextKey(), type: classify(src), src }];
    });
  }, []);

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

  /** The day's commands: its code blocks, one line each, in the order they were written. */
  const commands = useMemo(
    () =>
      rows.flatMap((row, index) => {
        if (row.type !== 'code') return [];
        const text = codeBody(row.src).trim();
        return text === '' ? [] : [{ index, text }];
      }),
    [rows],
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

        <div className="wr-blocks" data-testid="journal-blocks">
          {rows.length === 0 && (
            <p className="wr-blocks__empty" data-testid="journal-blocks-empty">
              Nothing logged on this day. Start with a note, or a command you ran.
            </p>
          )}
          {rows.map((row, index) =>
            editing === index ? (
              <textarea
                key={row.key}
                className="wr-input wr-blocks__editor"
                aria-label={`Block ${String(index + 1)} of the entry for ${selected}`}
                placeholder={row.type === 'code' ? 'A command, or a snippet' : 'Markdown'}
                data-testid={`journal-block-editor-${String(index)}`}
                autoFocus
                value={row.src}
                onChange={(event) => {
                  const src = event.target.value;
                  setRows((current) =>
                    current.map((candidate, at) =>
                      at === index ? { ...candidate, src, type: classify(src) } : candidate,
                    ),
                  );
                }}
                onBlur={() => void commit()}
              />
            ) : (
              <div
                key={row.key}
                className={`wr-block wr-block--${row.type}`}
                data-testid={`journal-block-${String(index)}`}
                data-block-type={row.type}
                role="button"
                tabIndex={0}
                title="Click to edit this block"
                onClick={() => setEditing(index)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setEditing(index);
                }}
              >
                <BlockBody block={row} />
              </div>
            ),
          )}
        </div>

        <div className="wr-blocks__insert">
          {/* Text and code only. An image block *renders* — the page shows one that is in the
              day's markdown — but nothing here can put bytes on the machine, so there is no
              affordance pretending to. */}
          <button
            type="button"
            className="wr-button"
            data-testid="journal-add-text"
            onClick={() => insert('')}
          >
            + text
          </button>
          <button
            type="button"
            className="wr-button"
            data-testid="journal-add-code"
            onClick={() => insert(EMPTY_CODE_BLOCK)}
          >
            + code
          </button>
          <button
            type="button"
            className="wr-button wr-button--quiet"
            data-testid="journal-save"
            onClick={() => void commit()}
          >
            Save day
          </button>
        </div>
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
                  onClick={() => setEditing(command.index)}
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
