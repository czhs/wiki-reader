/**
 * The directory: every notebook in the library (criterion P01).
 *
 * The unit of work is the notebook. Until milestone 5 the only way to see them all was a
 * 260px sidebar built to answer "what next?" — a queue, which is a judgement about order, not
 * a shelf. This is the shelf: a page, in the centre, listing every notebook with what its log
 * amounts to, and opening one lands on its page.
 *
 * It is also the directory of *journals*, because a journal belongs to its notebook (`P02`).
 * A row therefore has two doors — the page, and the log — and says enough about the log
 * (how many days, when the last one was, when the calendar begins) that the researcher does
 * not have to open each one to find out whether anything is in it.
 *
 * The queue keeps its job. Order is still a judgement and still lives there; the directory
 * shows the same hand-arranged order because a second opinion about what matters would be a
 * second authority, and re-sorting by date would throw the researcher's arrangement away.
 */
import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import { COMMAND_IDS } from '@wr/workbench';
import { isInTrash, isWorking, type JournalDate, type Question } from '@wr/shared-types';
import { useOpenContextMenu } from './context-menu.js';
import { NewNotebookControl } from './notebook-controls.js';
import { call, describeError, subscribe } from './ipc.js';
import { useWorkspace, type DockPanelProps } from './workspace.js';

interface Row {
  readonly notebook: Question;
  readonly entries: number;
  readonly lastEntry: JournalDate | null;
  readonly journalStart: JournalDate;
}

/**
 * One notebook on the shelf: its name, whatever the row says under it, and the doors beside it.
 *
 * The working rows and the dropped rows had the same `<li>` and the same name button written
 * out twice — the test ids among them, which is precisely the pair that must not drift, since
 * `[P01]` finds a notebook by `directory-item-<id>` whichever list it ended up in.
 */
function DirectoryRow({
  notebook,
  dropped = false,
  onOpen,
  onContextMenu,
  under,
  children,
}: {
  readonly notebook: Question;
  readonly dropped?: boolean;
  readonly onOpen: () => void;
  /** A right-click on the row: its two doors, from the registry (`R01`). */
  readonly onContextMenu: (event: ReactMouseEvent) => void;
  /** What the row says under its name. */
  readonly under: ReactNode;
  /** The doors beside the body. A dropped notebook has none: it is not being worked on. */
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <li
      className={dropped ? 'wr-directory__row wr-directory__row--dropped' : 'wr-directory__row'}
      data-testid={`directory-item-${notebook.id}`}
      data-notebook-id={notebook.id}
      data-status={notebook.status}
      onContextMenu={onContextMenu}
    >
      <div className="wr-directory__body">
        <button
          type="button"
          className="wr-directory__name"
          title="Open this notebook"
          data-testid={`directory-open-${notebook.id}`}
          onClick={onOpen}
        >
          {notebook.title}
        </button>
        {under}
      </div>
      {children}
    </li>
  );
}

export function NotebookDirectoryView({
  testId,
  revealed,
}: {
  readonly testId?: string;
  /**
   * Bumped whenever the page is shown again.
   *
   * Dockview hides a tab by detaching its content element, and React does not unmount a tree
   * whose host node was detached — so coming back to this tab re-attaches the same mounted
   * component and no effect re-runs on its own. Every count on this page is derived from the
   * library, and the two things most likely to change them happen on *other* pages: writing
   * today's entry in a notebook's journal, and naming a new notebook in the queue. Without
   * this the shelf a researcher returns to is the shelf as it was when they left the tab.
   */
  readonly revealed?: number;
}): JSX.Element {
  const { store, workbench } = useWorkspace();
  const openMenu = useOpenContextMenu();
  const [rows, setRows] = useState<readonly Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await call('notebook:directory', {});
      setRows(result.notebooks);
      setError(null);
    } catch (failure) {
      setError(describeError(failure).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revealed]);

  // The changes the main process announces. `journal:changed` moves a row's day count,
  // `library:changed` covers an import, and `notebook:changed` covers a board drop; a notebook
  // created or renamed elsewhere in this window arrives with the next reveal.
  useEffect(() => {
    const unsubscribes = [
      subscribe('journal:changed', () => {
        void load();
      }),
      subscribe('library:changed', () => {
        void load();
      }),
      subscribe('notebook:changed', () => {
        void load();
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [load]);

  /** Both doors go through the command registry, like every other panel move. */
  const open = useCallback(
    async (commandId: string, questionId: string) => {
      try {
        await workbench.commands.execute(commandId, { questionId }, workbench.context());
      } catch (failure) {
        store.setStatus(describeError(failure).message, 'error');
      }
    },
    [store, workbench],
  );

  const add = useCallback(
    async (title: string): Promise<boolean> => {
      try {
        const { question } = await call('question:create', { title });
        await load();
        // Straight into it: a notebook you have just named is one you are about to write in.
        await open(COMMAND_IDS.openNotebook, question.id);
        return true;
      } catch (failure) {
        store.setStatus(describeError(failure).message, 'error');
        return false;
      }
    },
    [load, open, store],
  );

  if (error !== null) return <ErrorState message={error} testId={testId ?? 'notebook-directory'} />;
  if (rows === null) {
    return <EmptyState message="Reading the shelf…" testId={testId ?? 'notebook-directory'} />;
  }

  // The bin is the queue's, and a notebook in it is off every shelf until it is put back or
  // the bin is emptied (`U11`) — so the directory does not draw it at all rather than showing
  // a dropped notebook that Restore would not actually restore.
  const shelved = rows.filter((row) => !isInTrash(row.notebook));
  const working = shelved.filter((row) => isWorking(row.notebook));
  const dropped = shelved.filter((row) => !isWorking(row.notebook));

  return (
    <div className="wr-directory" data-testid={testId ?? 'notebook-directory'}>
      <header className="wr-directory__head">
        <h2 className="wr-directory__title">Notebooks</h2>
        <p className="wr-directory__blurb">
          One notebook per line of work: its page, its claims, and the log of the days you
          worked on it.
        </p>
      </header>

      <NewNotebookControl testIdPrefix="directory" className="wr-directory__add" onAdd={add} />

      {working.length === 0 ? (
        <div className="wr-state" data-testid="directory-empty">
          <p className="wr-state__message">No notebooks yet.</p>
          <p className="wr-state__hint">
            A notebook is one line of work — what you are trying to find out, the papers that
            bear on it, and the days you spent on it.
          </p>
        </div>
      ) : (
        <ul className="wr-directory__list" data-testid="directory-list">
          {working.map((row) => (
            <DirectoryRow
              key={row.notebook.id}
              notebook={row.notebook}
              onOpen={() => void open(COMMAND_IDS.openNotebook, row.notebook.id)}
              onContextMenu={(event) => {
                openMenu(event, 'notebook', { questionId: row.notebook.id });
              }}
              under={
                <>
                  {row.notebook.description !== null && (
                    <span className="wr-directory__description">{row.notebook.description}</span>
                  )}
                  {row.notebook.nextAction !== null && (
                    <span className="wr-directory__next">Next: {row.notebook.nextAction}</span>
                  )}
                </>
              }
            >
              <span
                className="wr-directory__status"
                data-testid={`directory-status-${row.notebook.id}`}
              >
                {row.notebook.status}
              </span>

              {/* The journal half of the row. The counts are what make the directory of
                  journals a directory rather than a list of identical links. */}
              <button
                type="button"
                className="wr-button wr-button--quiet"
                title="Open this notebook’s journal"
                data-testid={`directory-journal-${row.notebook.id}`}
                data-entries={String(row.entries)}
                onClick={() => void open(COMMAND_IDS.openJournal, row.notebook.id)}
              >
                {row.entries === 0
                  ? `Journal — nothing yet, from ${row.journalStart}`
                  : `Journal — ${String(row.entries)} ${row.entries === 1 ? 'day' : 'days'}, last ${String(row.lastEntry ?? '')}`}
              </button>
            </DirectoryRow>
          ))}
        </ul>
      )}

      {dropped.length > 0 && (
        <>
          <h3 className="wr-list__section" data-testid="directory-dropped-heading">
            Dropped
            <span className="wr-list__section-count">{dropped.length}</span>
          </h3>
          <ul className="wr-directory__list wr-directory__list--dropped">
            {dropped.map((row) => (
              <DirectoryRow
                key={row.notebook.id}
                notebook={row.notebook}
                dropped
                onOpen={() => void open(COMMAND_IDS.openNotebook, row.notebook.id)}
                onContextMenu={(event) => {
                  openMenu(event, 'notebook', { questionId: row.notebook.id });
                }}
                // The reason it was dropped is the useful residue of having opened it.
                under={
                  <span className="wr-directory__description">
                    {row.notebook.discardedReason ?? ''}
                  </span>
                }
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function NotebookDirectoryPanel({ api }: DockPanelProps): JSX.Element {
  // Dockview's own signal for "this tab is on screen again", which is the only event that
  // covers a change made on another page through a route that publishes nothing.
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    const subscription = api.onDidVisibilityChange((event) => {
      if (event.isVisible) setRevealed((count) => count + 1);
    });
    return () => {
      subscription.dispose();
    };
  }, [api]);
  return <NotebookDirectoryView revealed={revealed} />;
}
