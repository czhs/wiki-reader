/**
 * The surfaces that stand over the workspace: the command list, the file list, the link picker,
 * and the notebook picker.
 *
 * They share a sheet (`Overlay`) and a dismissal (`useCloseOnEscape`), and differ in what they
 * are asking. Escape is captured on the window rather than bound to the dialog because focus is
 * usually inside a reader when one of these opens.
 *
 * Both exist because the mechanism was already there and nothing pointed at it. The command
 * and keybinding registries have always known which chord runs what (`L09`), but the only way
 * to find an action was to already know its key — so `K03` is a *rendering* of the registry,
 * not a hand-written table of shortcuts that would drift the first time a binding moved. And
 * `links` has always held typed directed edges, but nothing in a reader could make one, so
 * `K01` is a gesture over `link:create` where both the other end and the relationship are
 * chosen by the researcher.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ellipsize } from '@wr/document-model';
import {
  COMMAND_IDS,
  linkTypeLabel,
  linkTypesFor,
  parseKeystroke,
  type EntityRef,
  type Platform,
} from '@wr/workbench';
import {
  DocumentIdSchema,
  LinkableEntityTypeSchema,
  type DocumentLedgerHighlight,
  type HypothesisInNotebook,
  type LibraryItem,
  type Question,
} from '@wr/shared-types';
import { FocusPanelBody } from './focus-panel.js';
import { call, describeError } from './ipc.js';
import { WikiPanelBody } from './wiki-panel.js';
import { annotationTextIn, type WorkspaceState } from './store.js';
import { useWorkspace, useWorkspaceState, type LibraryData } from './workspace.js';

/**
 * Everything the library holds, as one list.
 *
 * The store keeps the three ingestion paths apart because the library sidebar shows them as
 * three sections. Nothing that *searches* the library cares which path a file came in by, and
 * both surfaces below had their own copy of the concatenation — so a fourth path would have
 * been findable in the sidebar and invisible to the file list.
 */
function everythingInLibrary(library: LibraryData): readonly LibraryItem[] {
  return [...library.items, ...library.notes, ...library.added];
}

/**
 * Escape closes whatever is over the workspace, before anything under it sees the key.
 *
 * Captured on `window` rather than bound to the dialog, because the focus may be inside a
 * reader panel when the overlay opens; `stopPropagation` is what keeps Escape from also
 * reaching the reader underneath and cancelling its selection.
 */
export function useCloseOnEscape(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [close, open]);
}

/**
 * The sheet an overlay sits on: a scrim that dismisses, and whatever is over it.
 *
 * All three surfaces here are the same gesture — something takes the whole window until it is
 * answered or dismissed — and were three copies of the same four elements.
 */
export function Overlay({
  name,
  onDismiss,
  children,
}: {
  /** Names both test ids: `<name>-overlay` and `<name>-scrim`. */
  readonly name: string;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="wr-overlay" data-testid={`${name}-overlay`}>
      <div
        className="wr-overlay__scrim"
        data-testid={`${name}-scrim`}
        role="presentation"
        onClick={onDismiss}
      />
      {children}
    </div>
  );
}

/** Modifier glyphs, in the order macOS prints them. */
const MAC_MODIFIERS: readonly (readonly ['ctrl' | 'alt' | 'shift' | 'meta', string])[] = [
  ['ctrl', '⌃'],
  ['alt', '⌥'],
  ['shift', '⇧'],
  ['meta', '⌘'],
];

const KEY_NAMES: Readonly<Record<string, string>> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↩',
  escape: 'Esc',
  ' ': 'Space',
  '-': '−',
};

/**
 * A chord as a person reads it.
 *
 * The canonical form (`meta+shift+p`) is what the registry compares on and what the row keeps
 * in `data-chord`; this is what goes on screen. Two forms rather than one because a test that
 * asserted on `⇧⌘P` would be asserting about a font, and a user shown `meta+shift+p` would be
 * being told the key in a notation nothing on their keyboard uses.
 */
export function displayChord(chord: string, platform: Platform): string {
  const keystroke = parseKeystroke(chord);
  const key = KEY_NAMES[keystroke.key] ?? keystroke.key.toUpperCase();
  if (platform === 'mac') {
    const glyphs = MAC_MODIFIERS.filter(([flag]) => keystroke[flag]).map(([, glyph]) => glyph);
    return `${glyphs.join('')}${key}`;
  }
  const words: string[] = [];
  if (keystroke.ctrl) words.push('Ctrl');
  if (keystroke.alt) words.push('Alt');
  if (keystroke.shift) words.push('Shift');
  if (keystroke.meta) words.push('Meta');
  words.push(key);
  return words.join('+');
}

/**
 * A chord printed beside the thing it runs.
 *
 * Eight places drew this `<kbd>` by hand, six of them behind the same `!== undefined` guard —
 * the status bar's three buttons, the watermark's ways in, the reader's three actions, a
 * context-menu item, the guide. Nothing when there is no chord, because a control followed by
 * an empty `<kbd>` reads as a binding that failed to load rather than one nobody made.
 */
export function Chord({
  chord,
  platform,
}: {
  readonly chord: string | undefined;
  readonly platform: Platform;
}): JSX.Element | null {
  if (chord === undefined) return null;
  return <kbd className="wr-kbd wr-kbd--inline">{displayChord(chord, platform)}</kbd>;
}

// ---------------------------------------------------------------------------
// The command list
// ---------------------------------------------------------------------------

/**
 * Every command, with the key that runs it (`K03`).
 *
 * The list is the registry, queried live — not a copy. That is the whole point: a binding
 * added to `DEFAULT_KEYBINDINGS` appears here without anyone remembering to also write it
 * down, and a binding that moved cannot be shown at its old chord.
 *
 * Disabled commands are shown greyed rather than hidden, as VS Code does. "Go Forward is a
 * thing this app can do, and it is not available right now" is information; an absence is
 * indistinguishable from the feature not existing.
 */
export function CommandList(): JSX.Element | null {
  const { store, workbench, run } = useWorkspace();
  const state = useWorkspaceState();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const open = state.commandsOpen;

  const close = useCallback(() => {
    store.update({ commandsOpen: false });
  }, [store]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    inputRef.current?.focus();
  }, [open]);

  useCloseOnEscape(open, close);

  // Re-queried on every render rather than memoized on `query`: a command's *enabled* state
  // depends on the context keys, which change under the palette while it is open.
  const results = open ? workbench.searchCommands(query) : [];
  const platform = workbench.keybindings.platform;

  if (!open) return null;

  return (
    <Overlay name="command-list" onDismiss={close}>
      <div className="wr-palette" data-testid="command-list" role="dialog" aria-label="All commands">
        <input
          ref={inputRef}
          className="wr-palette__input"
          type="search"
          placeholder="Search every command…"
          aria-label="Search every command"
          data-testid="command-list-filter"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="wr-palette__list" data-testid="command-list-results">
          {results.length === 0 && (
            <p className="wr-palette__empty" data-testid="command-list-empty">
              No command matches “{query}”.
            </p>
          )}
          {results.map(({ command, enabled }) => {
            const chords = workbench.keybindings.chordsForCommand(command.id);
            return (
              <button
                key={command.id}
                type="button"
                className={
                  enabled ? 'wr-palette__row' : 'wr-palette__row wr-palette__row--disabled'
                }
                data-testid={`command-row-${command.id}`}
                data-command-id={command.id}
                // The canonical chords, for anything comparing against the registry.
                data-chord={chords.join(' ')}
                data-enabled={enabled ? 'true' : 'false'}
                onClick={() => {
                  close();
                  void run(command.id);
                }}
              >
                <span className="wr-palette__label">{command.label}</span>
                <span className="wr-palette__chords">
                  {chords.map((chord) => (
                    <kbd className="wr-kbd" key={chord}>
                      {displayChord(chord, platform)}
                    </kbd>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// The file list
// ---------------------------------------------------------------------------

/**
 * Every file in the library, opened by typing its name (`D01`).
 *
 * The keyboard's way into a reader. Every other surface in the workspace is a page with a
 * name a hand can learn a chord for; a document is one of thousands, so the chord opens this
 * and the typing chooses — which is the same shape as the command list above, deliberately, so
 * that `Cmd+P` and `Cmd+Shift+P` are one gesture with two vocabularies rather than two
 * gestures.
 *
 * The arrow keys move a highlighted row and Enter opens it, because a list you can only click
 * would leave the keyboard route ending one step short of the document.
 */
export function FilePalette(): JSX.Element | null {
  const { store, library, openDocument } = useWorkspace();
  const state = useWorkspaceState();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const open = state.filesOpen;

  const close = useCallback(() => {
    store.update({ filesOpen: false });
  }, [store]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActive(0);
      return;
    }
    inputRef.current?.focus();
  }, [open]);

  const matches = useMemo(() => {
    const everything = everythingInLibrary(library);
    const needle = query.trim().toLowerCase();
    if (needle === '') return everything;
    return everything.filter((item) => item.document.title.toLowerCase().includes(needle));
  }, [library, query]);

  // Clamped rather than reset: narrowing the query must not silently arm Enter on a row the
  // researcher cannot see.
  const index = matches.length === 0 ? 0 : Math.min(active, matches.length - 1);

  const openAt = useCallback(
    (position: number) => {
      const item = matches[position];
      if (item === undefined) return;
      close();
      void openDocument(item.document.id, 'current');
    },
    [close, matches, openDocument],
  );

  useCloseOnEscape(open, close);

  // Escape is the shared hook's, above; what is this palette's own is moving the highlighted
  // row and opening it, which no other overlay has.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setActive((current) => {
          const count = matches.length;
          if (count === 0) return 0;
          const from = Math.min(current, count - 1);
          return (((from + delta) % count) + count) % count;
        });
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        openAt(index);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [index, matches.length, open, openAt]);

  if (!open) return null;

  return (
    <Overlay name="file-list" onDismiss={close}>
      <div className="wr-palette" data-testid="file-list" role="dialog" aria-label="Go to file">
        <input
          ref={inputRef}
          className="wr-palette__input"
          type="search"
          placeholder="Go to a file by name…"
          aria-label="Go to a file by name"
          data-testid="file-list-filter"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <div className="wr-palette__list" data-testid="file-list-results">
          {matches.length === 0 && (
            <p className="wr-palette__empty" data-testid="file-list-empty">
              No file in the library is called “{query}”.
            </p>
          )}
          {matches.map((item, position) => (
            <button
              key={item.document.id}
              type="button"
              className={
                position === index ? 'wr-palette__row wr-palette__row--active' : 'wr-palette__row'
              }
              data-testid={`file-row-${item.document.id}`}
              data-active={position === index ? 'true' : 'false'}
              onClick={() => openAt(position)}
            >
              <span className="wr-palette__label">{item.document.title}</span>
              {/* What it is, so two papers with similar names are told apart by kind before
                  either is opened. */}
              <span className="wr-palette__kind">{item.document.docType}</span>
            </button>
          ))}
        </div>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// The link picker
// ---------------------------------------------------------------------------

/**
 * Linking what is being read to something else.
 *
 * One question, since milestone 7: *what is the other end?* The picker used to ask a second —
 * name the relationship — and refuse to make the link until it was answered. The researcher's
 * verdict was that they never wanted to be asked (`H05`): a link is a link, the kinds all read
 * the same on a map, and the toll was paid on every single connection. So the chooser is gone
 * and the edge is written plainly (`related-to`); `links` keeps its typed rows and everything
 * that reads one goes on reading it.
 *
 * The one thing still worth asking about is a claim (`E02`). Evidence either bears a hypothesis
 * out or tells against it — the notebook page draws its two lines from exactly that — so an
 * untyped edge to one would appear under neither and count for nothing. That is not a *kind of
 * link*, it is which side the evidence falls on, which is why it survives a criterion that
 * removed the kinds.
 *
 * A file is not the only thing in a file (`H06`). Choosing one in the list opens it out into
 * the sentences marked in it, searchable, because the thing being connected is usually a
 * sentence and a picker that could only reach the paper made the researcher find the sentence
 * some other way first. A file with nothing marked in it says so and stays the target rather
 * than presenting an empty list as an error.
 *
 * Two things widened in milestone 5. The source is an entity, not a document, so a highlight
 * can be the end an assertion is made *from* (`H02`). And the other end can be found by
 * looking: the second tab is the library as a place, and picking one file out of it puts that
 * file in the middle with its own highlights around it, each of them a target (`H04`). Which
 * is the same pair of surfaces `F01` and `F02` already are — a picker with its own private map
 * would be a second thing to keep true. The list tab's second stage and that map are two routes
 * to the same `pick(entityType, entityId)`, deliberately: one entry point, two ways in.
 */
type PickerTab = 'list' | 'graph';

/** As much of a marked sentence as a picker row shows. Longer than a node's label. */
const QUOTE_IN_PICKER = 96;

/** How many of a file's edges the second stage asks for. It only wants the other array. */
const LEDGER_IN_PICKER = 400;

/**
 * A file the list tab has opened out, and what is marked in it (`H06`).
 *
 * `marks: null` is "not answered yet" and `[]` is "nothing is marked in it" — two states the
 * stage says differently, because an empty list drawn while the query is still running reads
 * as an answer nobody gave.
 */
interface OpenedFile {
  readonly documentId: string;
  readonly title: string;
  readonly marks: readonly DocumentLedgerHighlight[] | null;
  /** True when the query failed. The file is still the target; the line says why the list is bare. */
  readonly failed: boolean;
}

export function LinkPicker(): JSX.Element | null {
  const { store, library, run } = useWorkspace();
  const state = useWorkspaceState();
  const source = state.linkDraftSource;

  const [target, setTarget] = useState<EntityRef | null>(null);
  const [linkType, setLinkType] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState<PickerTab>('list');
  /** Which file the graph tab has in the middle. Null while it is showing the whole map. */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** Every claim in the library, loaded once per opening (`E02`). */
  const [claims, setClaims] = useState<readonly HypothesisInNotebook[]>([]);
  /** The file the list tab has opened out, and what is marked in it (`H06`). */
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  /** The needle over *that file's* sentences — its own box, because it is its own question. */
  const [markFilter, setMarkFilter] = useState('');

  const close = useCallback(() => {
    store.update({ linkDraftSource: null });
  }, [store]);

  useEffect(() => {
    if (source === null) {
      setTarget(null);
      setLinkType(null);
      setFilter('');
      setTab('list');
      setFocusedId(null);
      setClaims([]);
      setOpened(null);
      setMarkFilter('');
      return;
    }
    // The claims are not in the store: nothing else in the workspace needs the whole list, and
    // keeping a copy in sync with every notebook edit would be a cache to be wrong.
    void (async () => {
      try {
        const result = await call('hypothesis:list', {});
        setClaims(result.claims);
      } catch {
        // A picker with no claims in it is still a working picker; the files are the common
        // case and losing them because a second query failed would be the worse answer.
        setClaims([]);
      }
    })();
  }, [source]);

  useCloseOnEscape(source !== null, close);

  const candidates = useMemo(() => {
    const everything = everythingInLibrary(library);
    const needle = filter.trim().toLowerCase();
    return everything
      .filter((item) => item.document.id !== source?.entityId)
      .filter((item) => needle === '' || item.document.title.toLowerCase().includes(needle));
  }, [filter, library, source]);

  /** The claims the same filter box matches — by what they say, or by whose notebook. */
  const claimCandidates = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return claims;
    return claims.filter(
      (claim) =>
        claim.hypothesis.statement.toLowerCase().includes(needle) ||
        claim.notebookTitle.toLowerCase().includes(needle),
    );
  }, [claims, filter]);

  /**
   * Which way the evidence cuts, when the other end is a claim (`E02`).
   *
   * Empty for everything else, and that emptiness is `H05`: there is no relationship to choose
   * between two files, so nothing is drawn and nothing is waited for.
   */
  const stances = useMemo(
    () =>
      source === null || target?.entityType !== 'hypothesis'
        ? []
        : linkTypesFor(source.entityType, 'hypothesis'),
    [source, target],
  );

  // A stance chosen against one claim does not survive being re-aimed at a file: there is
  // nothing for it to mean there, and carrying it would submit a type the command will refuse.
  useEffect(() => {
    if (linkType !== null && !stances.includes(linkType)) setLinkType(null);
  }, [linkType, stances]);

  const pick = useCallback((entityType: string, entityId: string) => {
    const parsed = LinkableEntityTypeSchema.safeParse(entityType);
    if (!parsed.success) return;
    setTarget({ entityId, entityType: parsed.data });
  }, []);

  /**
   * Open a file out into what is marked in it (`H06`).
   *
   * The file becomes the target in the same movement, so a researcher who meant the paper is
   * already done and one who meant a sentence is one click from it. `link:findForDocument` is
   * the query rather than `annotation:listByDocument` because it answers both halves at once
   * and each sentence arrives with how much has already been said about it — which is the
   * signal the ledger draws its groups from.
   */
  const openFile = useCallback((documentId: string, title: string) => {
    pick('document', documentId);
    setMarkFilter('');
    setOpened({ documentId, title, marks: null, failed: false });
    const parsed = DocumentIdSchema.safeParse(documentId);
    if (!parsed.success) {
      setOpened({ documentId, title, marks: [], failed: true });
      return;
    }
    void call('link:findForDocument', { documentId: parsed.data, limit: LEDGER_IN_PICKER })
      .then((answer) => {
        setOpened((now) =>
          now === null || now.documentId !== documentId
            ? now
            : { ...now, marks: answer.highlights },
        );
      })
      .catch(() => {
        // A file whose sentences could not be read is still linkable as a file, which is the
        // whole point of the empty case below: the stage says what it knows and the target
        // stands.
        setOpened((now) =>
          now === null || now.documentId !== documentId
            ? now
            : { ...now, marks: [], failed: true },
        );
      });
  }, [pick]);

  /** The sentences of the opened file that the second box matches. */
  const marks = useMemo(() => {
    const all = opened?.marks ?? [];
    const needle = markFilter.trim().toLowerCase();
    if (needle === '') return all;
    return all.filter((mark) => mark.label.toLowerCase().includes(needle));
  }, [markFilter, opened]);

  if (source === null) return null;

  const sourceLabel = describeLinkSource(source, state);
  // Nothing else to answer: a target is the whole of it, unless it is a claim.
  const ready = target !== null && (target.entityType !== 'hypothesis' || linkType !== null);
  const startFile = source.entityType === 'document' ? source.entityId : (source.documentId ?? null);

  return (
    <Overlay name="link-picker" onDismiss={close}>
      <div className="wr-picker" data-testid="link-picker" role="dialog" aria-label="Link this to something else">
        <h2 className="wr-picker__title" data-testid="link-picker-source">
          Link {sourceLabel} to
        </h2>

        <section className="wr-picker__section">
          <div className="wr-picker__tabs" data-testid="link-picker-tabs">
            <button
              type="button"
              className={tab === 'list' ? 'wr-picker__tab wr-picker__tab--chosen' : 'wr-picker__tab'}
              aria-pressed={tab === 'list'}
              data-testid="link-picker-tab-list"
              onClick={() => setTab('list')}
            >
              By title
            </button>
            <button
              type="button"
              className={tab === 'graph' ? 'wr-picker__tab wr-picker__tab--chosen' : 'wr-picker__tab'}
              aria-pressed={tab === 'graph'}
              data-testid="link-picker-tab-graph"
              onClick={() => {
                setTab('graph');
                setFocusedId(startFile);
              }}
            >
              By looking
            </button>
          </div>

          {tab === 'list' && opened !== null ? (
            /*
              The second stage (`H06`): one file, opened out into what is marked in it.
              A stage rather than a nested list, because the question has changed — the
              researcher has stopped looking for a file and started looking inside one — and a
              list that grew rows under a row would leave both questions on screen at once.
            */
            <div
              className="wr-picker__stage"
              data-testid="link-picker-marks"
              data-document-id={opened.documentId}
              data-mark-count={String(opened.marks?.length ?? 0)}
            >
              <div className="wr-picker__stage-head">
                <button
                  type="button"
                  className="wr-button"
                  data-testid="link-picker-back"
                  onClick={() => {
                    setOpened(null);
                    setMarkFilter('');
                  }}
                >
                  ← another file
                </button>
                <h3 className="wr-picker__heading">Inside “{opened.title}”</h3>
              </div>
              {opened.marks === null ? (
                <p className="wr-picker__empty" data-testid="link-picker-marks-loading">
                  Reading what is marked in it…
                </p>
              ) : opened.marks.length === 0 ? (
                /* The honest empty case: not an error, and not a dead end — the file the
                   researcher chose is already the target, and the line says so. */
                <p className="wr-picker__empty" data-testid="link-picker-no-highlights">
                  {opened.failed
                    ? 'Its marked sentences could not be read — linking the file itself.'
                    : 'No sentences are marked in this file — linking the file itself.'}
                </p>
              ) : (
                <>
                  <input
                    className="wr-picker__filter"
                    type="search"
                    placeholder="Search the sentences marked in it…"
                    aria-label="Search the sentences marked in this file"
                    data-testid="link-picker-mark-filter"
                    value={markFilter}
                    onChange={(event) => setMarkFilter(event.target.value)}
                  />
                  <div
                    className="wr-picker__list"
                    data-testid="link-picker-highlights"
                    data-shown={String(marks.length)}
                  >
                    {marks.length === 0 && (
                      <p className="wr-picker__empty" data-testid="link-picker-no-mark-matches">
                        Nothing marked in it says “{markFilter}”.
                      </p>
                    )}
                    {marks.map((mark) => (
                      <button
                        key={mark.annotationId}
                        type="button"
                        className={
                          mark.annotationId === target?.entityId
                            ? 'wr-picker__option wr-picker__option--chosen'
                            : 'wr-picker__option'
                        }
                        aria-pressed={mark.annotationId === target?.entityId}
                        data-testid={`link-picker-highlight-${mark.annotationId}`}
                        onClick={() => pick('annotation', mark.annotationId)}
                      >
                        <span className="wr-picker__label">
                          “{ellipsize(mark.label, QUOTE_IN_PICKER)}”
                        </span>
                        {/* How much has already been said about this sentence — the same fact
                            the ledger groups by, so an unlinked one is visibly the one nobody
                            has connected yet. */}
                        <span className="wr-picker__kind">
                          {mark.links === 0
                            ? 'nothing said yet'
                            : mark.links === 1
                              ? '1 link'
                              : `${String(mark.links)} links`}
                        </span>
                      </button>
                    ))}
                  </div>
                  {/* The file itself is still reachable from inside it: opening a paper out is
                      not a commitment to one of its sentences. */}
                  <button
                    type="button"
                    className={
                      opened.documentId === target?.entityId
                        ? 'wr-picker__option wr-picker__option--chosen'
                        : 'wr-picker__option'
                    }
                    aria-pressed={opened.documentId === target?.entityId}
                    data-testid={`link-picker-target-${opened.documentId}`}
                    onClick={() => pick('document', opened.documentId)}
                  >
                    the file itself, “{opened.title}”
                  </button>
                </>
              )}
            </div>
          ) : tab === 'list' ? (
            <>
              <input
                className="wr-picker__filter"
                type="search"
                placeholder="Filter the library…"
                aria-label="Filter the library"
                data-testid="link-picker-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              <div className="wr-picker__list" data-testid="link-picker-targets">
                {candidates.length === 0 && claimCandidates.length === 0 && (
                  <p className="wr-picker__empty" data-testid="link-picker-no-targets">
                    Nothing else in the library to link to.
                  </p>
                )}
                {candidates.map((item) => (
                  <button
                    key={item.document.id}
                    type="button"
                    className={
                      item.document.id === target?.entityId
                        ? 'wr-picker__option wr-picker__option--chosen'
                        : 'wr-picker__option'
                    }
                    aria-pressed={item.document.id === target?.entityId}
                    data-testid={`link-picker-target-${item.document.id}`}
                    onClick={() => openFile(item.document.id, item.document.title)}
                  >
                    {item.document.title}
                  </button>
                ))}

                {/* The claims, under their own heading (`E02`). A separate list rather than
                    more rows, because what may be said to a claim is a different vocabulary
                    from what may be said to a file, and the researcher should be able to see
                    which kind of thing they are aiming at before the buttons below change. */}
                {claimCandidates.length > 0 && (
                  <h3 className="wr-picker__heading" data-testid="link-picker-claims-heading">
                    Claims
                  </h3>
                )}
                {claimCandidates.map(({ hypothesis, notebookTitle }) => (
                  <button
                    key={hypothesis.id}
                    type="button"
                    className={
                      hypothesis.id === target?.entityId
                        ? 'wr-picker__option wr-picker__option--chosen'
                        : 'wr-picker__option'
                    }
                    aria-pressed={hypothesis.id === target?.entityId}
                    data-testid={`link-picker-target-${hypothesis.id}`}
                    onClick={() => pick('hypothesis', hypothesis.id)}
                  >
                    <span className="wr-picker__label">{hypothesis.statement}</span>
                    {/* Which notebook it was claimed in: two lines of work can both be
                        claiming something about the same thing. */}
                    <span className="wr-picker__kind">{notebookTitle}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="wr-picker__graph" data-testid="link-picker-graph">
              {focusedId === null ? (
                <WikiPanelBody heading="Pick a file to look inside" onChoose={setFocusedIdFrom(setFocusedId)} />
              ) : (
                <>
                  <button
                    type="button"
                    className="wr-button"
                    data-testid="link-picker-graph-back"
                    onClick={() => setFocusedId(null)}
                  >
                    Back to the map
                  </button>
                  <FocusPanelBody
                    documentId={focusedId}
                    picking={{
                      onPick: pick,
                      onRefocus: setFocusedId,
                      chosenKey:
                        target === null ? null : `${target.entityType} ${target.entityId}`,
                    }}
                  />
                </>
              )}
            </div>
          )}
        </section>

        <section className="wr-picker__section">
          {/* What was chosen, and nothing about how. There is no second question here any
              more (`H05`) — the line reads back the one answer the picker collected. */}
          <p className="wr-picker__chosen" data-testid="link-picker-chosen">
            {target === null ? 'Nothing chosen yet.' : describeLinkTarget(target, state, claims)}
          </p>
          {stances.length > 0 && (
            <>
              <h3 className="wr-picker__heading">Which way does this evidence cut?</h3>
              <div className="wr-picker__types" data-testid="link-picker-types">
                {stances.map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={
                      type === linkType
                        ? 'wr-picker__type wr-picker__type--chosen'
                        : 'wr-picker__type'
                    }
                    aria-pressed={type === linkType}
                    data-testid={`link-picker-type-${type}`}
                    onClick={() => setLinkType(type)}
                  >
                    {linkTypeLabel(type)}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>

        <footer className="wr-picker__footer">
          <button type="button" className="wr-button" data-testid="link-picker-cancel" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="wr-button wr-button--primary"
            data-testid="link-picker-create"
            disabled={!ready}
            // The command writes the edge; this only collects the two choices. Which means
            // the same link can be made from a keybinding, a menu or a test without this
            // component being involved at all.
            onClick={() => {
              if (target === null) return;
              void run(COMMAND_IDS.createDocumentLink, {
                sourceId: source.entityId,
                sourceType: source.entityType,
                ...(source.documentId === undefined ? {} : { documentId: source.documentId }),
                targetId: target.entityId,
                targetType: target.entityType,
                // Omitted for everything but a claim: the command writes the plain edge when
                // nobody named one, which is the whole of `H05` on this side of the boundary.
                ...(linkType === null ? {} : { linkType }),
              });
            }}
          >
            Create link
          </button>
        </footer>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Sending what you are reading to a notebook
// ---------------------------------------------------------------------------

/**
 * Which notebook this paper, or this sentence, belongs on the desk of (`E01`).
 *
 * One question rather than the link picker's two, and that is the whole reason it is a separate
 * surface: the relationship is already known — the notebook refers to this — so asking for it
 * would be asking the researcher to name something they cannot get wrong. What is left is a
 * list of the notebooks they are working in, filtered by typing, the same gesture the file
 * palette is.
 *
 * Discarded notebooks are not offered. Sending evidence to a line of work that has been set
 * aside is the one choice here that is almost certainly a mistake, and `I01` gives it a way
 * back if it was not.
 */
export function NotebookPicker(): JSX.Element | null {
  const { store, host } = useWorkspace();
  const state = useWorkspaceState();
  const source = state.notebookDraftSource;

  const [notebooks, setNotebooks] = useState<readonly Question[] | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    store.update({ notebookDraftSource: null });
  }, [store]);

  useCloseOnEscape(source !== null, close);

  useEffect(() => {
    if (source === null) {
      setFilter('');
      setNotebooks(null);
      setError(null);
      return;
    }
    void (async () => {
      try {
        const result = await call('question:list', { status: ['active', 'queued'] });
        setNotebooks(result.questions);
      } catch (failure) {
        setError(describeError(failure).message);
        setNotebooks([]);
      }
    })();
  }, [source]);

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = notebooks ?? [];
    if (needle === '') return all;
    return all.filter((notebook) => notebook.title.toLowerCase().includes(needle));
  }, [filter, notebooks]);

  if (source === null) return null;

  const sourceLabel = describeLinkSource(source, state);

  return (
    <Overlay name="notebook-picker" onDismiss={close}>
      <div
        className="wr-picker"
        data-testid="notebook-picker"
        role="dialog"
        aria-label="Send this to a notebook"
        data-source-type={source.entityType}
      >
        <h2 className="wr-picker__title" data-testid="notebook-picker-source">
          Send {sourceLabel} to
        </h2>
        <input
          className="wr-input"
          type="search"
          autoFocus
          placeholder="Which notebook?"
          aria-label="Which notebook?"
          data-testid="notebook-picker-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="wr-picker__list" data-testid="notebook-picker-targets">
          {error !== null && (
            <p className="wr-picker__empty" data-testid="notebook-picker-error">
              {error}
            </p>
          )}
          {notebooks !== null && error === null && matches.length === 0 && (
            <p className="wr-picker__empty" data-testid="notebook-picker-empty">
              {notebooks.length === 0
                ? 'No notebook is open. Start one in What next, and this will land on its desk.'
                : `No notebook you are working in is called “${filter}”.`}
            </p>
          )}
          {matches.map((notebook) => (
            <button
              key={notebook.id}
              type="button"
              className="wr-picker__option"
              data-testid={`notebook-picker-target-${notebook.id}`}
              onClick={() => {
                void host.sendToNotebook(source, { id: notebook.id, title: notebook.title });
              }}
            >
              <span className="wr-picker__label">{notebook.title}</span>
              <span className="wr-picker__kind">{notebook.status}</span>
            </button>
          ))}
        </div>
        <footer className="wr-picker__footer">
          <button
            type="button"
            className="wr-button"
            data-testid="notebook-picker-cancel"
            onClick={close}
          >
            Cancel
          </button>
        </footer>
      </div>
    </Overlay>
  );
}

/** The map hands back `(type, id)`; only a file can be looked inside. */
function setFocusedIdFrom(
  setFocusedId: (id: string) => void,
): (entityType: string, entityId: string) => void {
  return (entityType, entityId) => {
    if (entityType === 'document') setFocusedId(entityId);
  };
}

/** As much of a quoted sentence as fits in a picker's heading without wrapping it. */
const QUOTE_LIMIT = 48;

/** How the end being linked *from* reads: a paper by its title, a highlight by its words. */
function describeLinkSource(source: EntityRef, state: WorkspaceState): string {
  if (source.entityType === 'annotation') {
    const quote = annotationTextIn(state, source.entityId);
    return quote === null ? 'this highlight' : `the highlight “${ellipsize(quote, QUOTE_LIMIT)}”`;
  }
  return `“${state.documentTitles[source.entityId] ?? 'this document'}”`;
}

/** And the end being linked *to*, so the relationship buttons are read against something. */
function describeLinkTarget(
  target: EntityRef,
  state: WorkspaceState,
  claims: readonly HypothesisInNotebook[],
): string {
  if (target.entityType === 'annotation') {
    const quote = annotationTextIn(state, target.entityId);
    return quote === null ? 'A highlight is chosen.' : `The highlight “${ellipsize(quote, QUOTE_LIMIT)}”`;
  }
  if (target.entityType === 'hypothesis') {
    const claim = claims.find((candidate) => candidate.hypothesis.id === target.entityId);
    return claim === undefined
      ? 'A claim is chosen.'
      : `The claim “${ellipsize(claim.hypothesis.statement, QUOTE_LIMIT)}”`;
  }
  return state.documentTitles[target.entityId] ?? 'A file is chosen.';
}


