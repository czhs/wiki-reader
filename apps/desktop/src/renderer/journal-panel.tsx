/**
 * A notebook's journal: a page in the workspace, showing one day at a time (N09–N11, P02–P05).
 *
 * It was a sidebar, which sized a day's thinking like a filter; then it was one page for the
 * whole library, which put two lines of thought on the same afternoon. A journal belongs to
 * its notebook (`P02`), so this page is opened *on* one and every read and write here names
 * it. The day's entry takes a reader's width in the centre, with the calendar in the margin
 * where a calendar belongs.
 *
 * The day's entry is a **block notebook** (`N11`): a sequence of text, code and image blocks
 * you click into one at a time. Blocks are a view over the day's single markdown document —
 * `journal-blocks.ts` parses them out and puts them back, and every commit writes the whole
 * document through `journal:write`. There is no block store, and nothing here executes
 * anything: a code block is a command someone jotted down, kept as the text they typed.
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
import { renderMarkdown } from '@wr/markdown-reader';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import {
  journalEntityId,
  QuestionIdSchema,
  type JournalEntry,
  type Question,
} from '@wr/shared-types';
import { calendarCells, type CalendarCell } from './journal-calendar.js';
import {
  classify,
  codeBody,
  codeLanguage,
  parseBlocks,
  serializeBlocks,
  sourceOffsetFor,
  EMPTY_CODE_BLOCK,
  type Block,
} from './journal-blocks.js';
import { call, describeError, subscribe } from './ipc.js';
import { useWorkspace, useWorkspaceState } from './workspace.js';

/** Today, as the calendar means it: the local calendar day, not a UTC instant. */
export function todayIso(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface Advance {
  readonly notebookId: string;
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

/** Which block is open, and where in it the caret should be (`P05`). */
interface Editing {
  readonly index: number;
  readonly offset: number;
}

let keySeq = 0;
const nextKey = (): number => {
  keySeq += 1;
  return keySeq;
};

const toRows = (blocks: readonly Block[]): BlockRow[] =>
  blocks.map((block) => ({ ...block, key: nextKey() }));

/**
 * Where in a block's markdown a click landed.
 *
 * `caretRangeFromPoint` is what the browser already uses to place a caret in text, so the
 * answer is the one the reader saw under their finger rather than a guess from a bounding
 * box. It answers in the *rendered* text; `sourceOffsetFor` carries that back to the source.
 * A click that lands on no text at all — the padding around a paragraph — falls back to the
 * end of the block, which is where someone clicking past the last word means to be.
 */
function offsetFromClick(element: HTMLElement, src: string, x: number, y: number): number {
  const rendered = element.textContent ?? '';
  const range = document.caretRangeFromPoint(x, y);
  if (range === null || !element.contains(range.startContainer)) return src.length;
  const upto = document.createRange();
  upto.selectNodeContents(element);
  upto.setEnd(range.startContainer, range.startOffset);
  return sourceOffsetFor(src, rendered, upto.toString().length);
}

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
  const { store } = useWorkspace();
  const [today] = useState(() => todayIso());
  const [selected, setSelected] = useState(() => todayIso());
  const [logged, setLogged] = useState<readonly string[] | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [rows, setRows] = useState<readonly BlockRow[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
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
        setRows(toRows(parseBlocks(found?.markdown ?? '')));
        setEditing(null);
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
    const name = notebook?.title ?? 'Journal';
    onTitle?.(selected === today ? `${name} — today` : `${name} — ${selected}`);
  }, [notebook, onTitle, selected, today]);

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
    if (parsedNotebookId === null) return;
    const markdown = serializeBlocks(rows);
    if (markdown === (entry?.markdown ?? '')) return;
    const date = selected;
    try {
      const result = await call('journal:write', {
        notebookId: parsedNotebookId,
        date,
        markdown,
      });
      if (selectedRef.current !== date) return;
      setEntry(result.entry);
      setRows(toRows(parseBlocks(result.entry?.markdown ?? '')));
      await loadCalendar();
    } catch (failure) {
      report(failure);
    }
  }, [entry, loadCalendar, parsedNotebookId, report, rows, selected]);

  /** Add a block at the end and open it: an inserted block is one you are about to type in. */
  const insert = useCallback((src: string) => {
    setRows((current) => {
      setEditing({ index: current.length, offset: src.length });
      return [...current, { key: nextKey(), type: classify(src), src }];
    });
  }, []);

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
        <p className="wr-journal-page__owner" data-testid="journal-notebook-title">
          {notebook?.title ?? ''}
        </p>

        {/*
          The drop target for a picture (`P04`). The attribute is read by the preload, which
          is the only place that can turn a dropped `File` into a path; the value names the
          day, and the main process writes the image into that day's markdown. Nothing here
          ever sees a path.
        */}
        <div
          className="wr-blocks"
          data-testid="journal-blocks"
          data-wr-drop-journal={`${notebookId}:${selected}`}
        >
          {rows.length === 0 && (
            <p className="wr-blocks__empty" data-testid="journal-blocks-empty">
              Nothing logged on this day. Start with a note, a command you ran, or drop in a
              picture.
            </p>
          )}
          {rows.map((row, index) =>
            editing?.index === index ? (
              <textarea
                key={row.key}
                className="wr-input wr-blocks__editor"
                aria-label={`Block ${String(index + 1)} of the entry for ${selected}`}
                placeholder={row.type === 'code' ? 'A command, or a snippet' : 'Markdown'}
                data-testid={`journal-block-editor-${String(index)}`}
                ref={(element) => {
                  // Focus and caret together, in the ref rather than through `autoFocus`:
                  // `autoFocus` lands the caret at 0, which is the whole of what `P05` is
                  // about. Guarded by the current selection so re-renders while typing do
                  // not drag the caret back to where the click was.
                  if (element === null || document.activeElement === element) return;
                  element.focus();
                  const at = Math.min(editing.offset, element.value.length);
                  element.setSelectionRange(at, at);
                }}
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
                onClick={(event) =>
                  setEditing({
                    index,
                    offset: offsetFromClick(
                      event.currentTarget,
                      row.src,
                      event.clientX,
                      event.clientY,
                    ),
                  })
                }
                onKeyDown={(event) => {
                  // Reached by the keyboard rather than by a click, so there is no point to
                  // honour: the end of the block is where someone about to add a line means.
                  if (event.key === 'Enter') setEditing({ index, offset: row.src.length });
                }}
              >
                <BlockBody block={row} />
              </div>
            ),
          )}
        </div>

        <div className="wr-blocks__insert">
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
          {/* No `+ image` button: a picture arrives by being dropped on the day, because the
              bytes have to come from the operating system and nothing in this world can ask
              for them. The hint says so rather than offering a button that cannot work. */}
          <span className="wr-blocks__hint" data-testid="journal-image-hint">
            drop a picture to add one
          </span>
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
                  onClick={() =>
                    setEditing({
                      index: command.index,
                      offset: rows[command.index]?.src.length ?? 0,
                    })
                  }
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
