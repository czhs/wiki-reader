/**
 * The Dockview panel components, one per `PanelKind`.
 *
 * Dockview mounts these by name; `componentFor` in `host.ts` is what maps a descriptor to
 * the key used here. Every panel takes its identity from the `panelId` param and reads what
 * it should be showing out of the workspace store, rather than from Dockview params — a
 * restored layout hands Dockview back only the ids, and the descriptors come from our own
 * persisted panel state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { AnnotationList, HighlightPopover } from '@wr/annotations';
import { NoteEditorView } from '@wr/note-editor';
import { PdfReaderView, createPdfAnchorFromSelection } from '@wr/pdf-reader';
import { MarkdownReaderView, createMarkdownAnchorFromSelection } from '@wr/markdown-reader';
import { HtmlReaderView, createHtmlAnchorFromSelection } from '@wr/html-reader';
import { EmptyState, ErrorState, ListRow, Panel } from '@wr/shared-ui';
import {
  COMMAND_IDS,
  entityRefFromInternalLink,
  linkTypeLabel,
  type PanelDescriptor,
} from '@wr/workbench';
import { describeLocation, resolveHtmlAnchor } from '@wr/document-model';
import {
  AnnotationIdSchema,
  DEFAULT_HIGHLIGHT_COLOR,
  DocumentIdSchema,
  NoteIdSchema,
  type AnnotationWithAnchor,
  type Author,
  type DocumentType,
  type InternalLink,
  type IpcResponse,
  type LibraryItem,
  type MarkdownLocation,
  type MarkdownReaderSelection,
  type PdfLocation,
  type PdfReaderSelection,
  type ResolvedLink,
  type ResolvedLocation,
  type SearchResult,
} from '@wr/shared-types';
import { createAnnotationEdits } from './annotation-actions.js';
import { displayChord } from './overlays.js';
import { useAnnotations, useDocumentData } from './document-data.js';
import { GraphPanel } from './graph-panel.js';
import { WikiPanel } from './wiki-panel.js';
import { FocusPanel } from './focus-panel.js';
import { NotebookPanel } from './notebook-panel.js';
import { NotebookDirectoryPanel } from './notebook-directory.js';
import { JournalPanel } from './journal-panel.js';
import { call, describeError, subscribe } from './ipc.js';
import { useWorkspace, useWorkspaceState } from './workspace.js';

/** One line in the collection picker, taken from the channel rather than restated here. */
type CollectionOption = IpcResponse<'zotero:listCollections'>['collections'][number];

/** Dockview passes `{ panelId }`; everything else is looked up from the store. */
interface PanelParams {
  readonly panelId: string;
}

type DockPanelProps = IDockviewPanelProps<PanelParams>;

function useDescriptor(panelId: string): PanelDescriptor | null {
  const state = useWorkspaceState();
  return state.panels[panelId] ?? null;
}

/** How long the reader stays still before its position is written back. */
const POSITION_SAVE_DEBOUNCE_MS = 600;

// ---------------------------------------------------------------------------
// PDF reader
// ---------------------------------------------------------------------------

function PdfPanelBody({ panelId, documentId }: {
  readonly panelId: string;
  readonly documentId: string;
}): JSX.Element {
  const { store, run } = useWorkspace();
  const state = useWorkspaceState();
  const { item, file, savedLocation, loading, error } = useDocumentData(documentId);
  const { annotations, refresh } = useAnnotations(documentId);
  const [selection, setSelection] = useState<PdfReaderSelection | null>(null);
  // Which highlight the reader has open for editing. Held by id rather than by value so the
  // popover redraws from the refreshed list after an edit instead of from a stale copy.
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const editing = annotations.find((entry) => entry.id === editingAnnotationId) ?? null;

  const reveal = state.reveals[panelId] ?? null;
  const revealLocation: PdfLocation | null =
    reveal !== null && reveal.location.kind === 'pdf' ? reveal.location : null;
  const initialLocation: PdfLocation | null =
    savedLocation !== null && savedLocation.kind === 'pdf' ? savedLocation : null;

  // --- reading position ---------------------------------------------------
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLocationChange = useCallback(
    (location: PdfLocation) => {
      const parsed = DocumentIdSchema.safeParse(documentId);
      if (!parsed.success) return;
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void call('document:setReadingPosition', {
          documentId: parsed.data,
          location,
        }).catch(() => {
          // A position that failed to save is not worth interrupting reading over; the
          // next scroll will try again.
        });
      }, POSITION_SAVE_DEBOUNCE_MS);
    },
    [documentId],
  );

  useEffect(
    () => () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    },
    [],
  );

  const onResolutions = useCallback(
    (resolutions: ReadonlyMap<string, ResolvedLocation | null>) => {
      store.setResolutions(documentId, resolutions);
    },
    [documentId, store],
  );

  // --- highlighting -------------------------------------------------------
  const createHighlight = useCallback(async () => {
    const parsed = DocumentIdSchema.safeParse(documentId);
    if (selection === null || file === null || !parsed.success) return;
    try {
      const { annotation } = await call('annotation:create', {
        documentId: parsed.data,
        kind: 'highlight',
        color: DEFAULT_HIGHLIGHT_COLOR,
        selectedText: selection.text,
        comment: null,
        anchor: createPdfAnchorFromSelection(selection, file.contentHash),
      });
      setSelection(null);
      await refresh();
      store.update({ selectedAnnotationId: annotation.id, selectedDocumentId: parsed.data });
      // Deliberately does *not* open the annotations sidebar. Doing so took 280px from the
      // reader mid-sentence, re-centring the page the user was reading — the jump that reads
      // as the document reloading. The highlight is confirmed where it was made: painted on
      // the page, plus the status line. `[UX03]` holds the reader still.
      store.setStatus(`Highlighted “${truncate(selection.text, 40)}”`);
    } catch (failure) {
      store.setStatus(describeError(failure).message, 'error');
    }
  }, [documentId, file, refresh, selection, store]);

  if (loading) return <EmptyState message="Opening document…" testId="pdf-panel-loading" />;
  if (error !== null) return <ErrorState message={error} testId="pdf-panel-error" />;
  if (item === null || file === null) {
    return <ErrorState message="This document has no file to open." testId="pdf-panel-error" />;
  }

  return (
    <div className="wr-reader-panel" data-testid={`pdf-panel-${panelId}`}>
      <ReaderActions documentId={documentId} />
      {selection !== null && (
        <div className="wr-selection-bar" data-testid="selection-toolbar">
          <span className="wr-selection-bar__text">“{truncate(selection.text, 60)}”</span>
          <button
            type="button"
            className="wr-button wr-button--primary"
            data-testid="create-highlight"
            onClick={() => void createHighlight()}
          >
            Highlight
          </button>
          <button
            type="button"
            className="wr-button"
            data-testid="dismiss-selection"
            onClick={() => setSelection(null)}
          >
            Cancel
          </button>
        </div>
      )}
      <PdfReaderView
        documentId={documentId}
        fileUrl={file.url}
        contentHash={file.contentHash}
        annotations={annotations}
        selectedAnnotationId={state.selectedAnnotationId}
        initialLocation={initialLocation}
        revealLocation={revealLocation}
        onSelection={setSelection}
        onActivateHighlight={(annotationId) => {
          setEditingAnnotationId(annotationId);
          // A click that missed only closes the editor. It deliberately does not clear the
          // selection: an annotation reached from search or the graph stays the current one.
          if (annotationId === null) return;
          const parsed = AnnotationIdSchema.safeParse(annotationId);
          if (parsed.success) store.update({ selectedAnnotationId: parsed.data });
        }}
        onLocationChange={onLocationChange}
        onResolutions={onResolutions}
        onError={(message) => store.setStatus(message, 'error')}
      />
      {editing !== null && (
        <ReaderHighlightEditor
          documentId={documentId}
          annotation={editing}
          onClose={() => {
            setEditingAnnotationId(null);
          }}
        />
      )}
      <button
        type="button"
        className="wr-hidden-action"
        data-testid="find-references-document"
        onClick={() => void run(COMMAND_IDS.findAllReferences)}
      >
        Find references
      </button>
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * The two things a reader can make from what it is showing: a link, and a note (`K01`, `K02`).
 *
 * A strip above the document rather than a menu, because both actions were unreachable before
 * — `link:create` and `note:create` have existed since milestone 1 and nothing in a reader
 * called either. A feature nothing points at is a feature nobody has.
 *
 * Both are commands, so the keybinding and the button are the same code path, and the label
 * carries the chord so pressing the button is how the key is learned. Neither writes anything
 * here: "Link…" opens the picker, and "New note" resolves what the note is *from* in the
 * workbench, where `getActiveEntity` already means "the highlight, or else the document".
 */
function ReaderActions({ documentId }: { readonly documentId: string }): JSX.Element {
  const { run, workbench } = useWorkspace();
  const state = useWorkspaceState();

  // A highlight counts as "here" only if it belongs to the document this strip is above:
  // the selection is workspace-wide, and a note offered as "on this highlight" while another
  // paper's highlight was selected would attach itself to the wrong passage.
  const selected = state.selectedAnnotationId;
  const onThisDocument =
    selected !== null &&
    (state.annotations[documentId] ?? []).some((entry) => entry.id === selected);

  const chord = (commandId: string): string | undefined =>
    workbench.keybindings.chordsForCommand(commandId)[0];

  const linkChord = chord(COMMAND_IDS.linkToDocument);
  const noteChord = chord(COMMAND_IDS.newNoteFromHere);
  const platform = workbench.keybindings.platform;

  return (
    <div className="wr-reader-actions" data-testid={`reader-actions-${documentId}`}>
      {/* The same rule the note button follows, for the same reason: a highlight is a thing
          in its own right, so with one selected here the link is made *from the sentence*
          (`H02`) rather than from the paper it happens to be in. With none, from the paper. */}
      <button
        type="button"
        className="wr-button"
        data-testid="reader-link"
        data-link-source={onThisDocument ? 'annotation' : 'document'}
        onClick={() =>
          void run(
            COMMAND_IDS.linkToDocument,
            onThisDocument
              ? { sourceId: selected, sourceType: 'annotation', documentId }
              : { sourceId: documentId, sourceType: 'document' },
          )
        }
      >
        {onThisDocument ? 'Link highlight…' : 'Link…'}
        {linkChord !== undefined && (
          <kbd className="wr-kbd wr-kbd--inline">{displayChord(linkChord, platform)}</kbd>
        )}
      </button>
      <button
        type="button"
        className="wr-button"
        data-testid="reader-new-note"
        data-note-source={onThisDocument ? 'annotation' : 'document'}
        onClick={() => void run(COMMAND_IDS.newNoteFromHere)}
      >
        {onThisDocument ? 'New note on highlight' : 'New note'}
        {noteChord !== undefined && (
          <kbd className="wr-kbd wr-kbd--inline">{displayChord(noteChord, platform)}</kbd>
        )}
      </button>
    </div>
  );
}

/**
 * The highlight editor a reader opens by clicking a highlight on the page.
 *
 * Shared by the PDF and markdown panels because it is one gesture — asking a highlight why it
 * was kept — and because the edits behind it must be the sidebar's own. `[W11]` is the reason
 * that matters: when the popover's handlers were written twice, no-op'ing one copy left every
 * test green. `createAnnotationEdits` is the single definition, and this is its second caller.
 *
 * The quote is shown because, unlike in the sidebar, there is no card above it saying which
 * highlight this is about — and the popover floats clear of the passage it names.
 */
function ReaderHighlightEditor({
  documentId,
  annotation,
  onClose,
}: {
  readonly documentId: string;
  readonly annotation: AnnotationWithAnchor;
  readonly onClose: () => void;
}): JSX.Element {
  const { store } = useWorkspace();
  const edits = createAnnotationEdits(documentId, {
    call,
    setAnnotations: (id, list) => {
      store.setAnnotations(id, list);
    },
    setStatus: (text, tone) => {
      store.setStatus(text, tone);
    },
  });

  return (
    <div className="wr-reader-popover" data-testid="reader-highlight-editor">
      <p className="wr-reader-popover__quote">“{truncate(annotation.selectedText, 90)}”</p>
      <HighlightPopover
        annotation={annotation}
        onChangeColor={(color) => {
          void edits.changeColor(annotation.id, color);
        }}
        onChangeComment={(comment) => {
          void edits.changeComment(annotation.id, comment);
          onClose();
        }}
        onDelete={() => {
          void edits.remove(annotation.id);
          onClose();
        }}
        onClose={onClose}
      />
    </div>
  );
}

/**
 * How one creator is shown in a list row.
 *
 * Zotero records institutional authors as a single `literal` name with no family/given split,
 * so preferring `literal` is what keeps "World Health Organization" from rendering blank.
 */
function authorLabel(author: Author): string {
  return author.literal ?? author.family;
}

function PdfPanel({ params }: DockPanelProps): JSX.Element {
  const descriptor = useDescriptor(params.panelId);
  if (descriptor === null || descriptor.kind !== 'pdf-reader') {
    return <EmptyState message="This panel has nothing to show." />;
  }
  return <PdfPanelBody panelId={params.panelId} documentId={descriptor.documentId} />;
}

// ---------------------------------------------------------------------------
// Markdown reader
// ---------------------------------------------------------------------------

function MarkdownPanelBody({ panelId, documentId }: {
  readonly panelId: string;
  readonly documentId: string;
}): JSX.Element {
  const { store, workbench } = useWorkspace();
  const state = useWorkspaceState();
  const { item, file, savedLocation, loading, error } = useDocumentData(documentId);
  const { annotations, refresh } = useAnnotations(documentId);
  const [selection, setSelection] = useState<MarkdownReaderSelection | null>(null);
  // As in the PDF panel: which highlight the page has open, held by id so the popover
  // redraws from the refreshed list rather than from a stale copy.
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const editing = annotations.find((entry) => entry.id === editingAnnotationId) ?? null;

  const reveal = state.reveals[panelId] ?? null;
  const revealLocation: MarkdownLocation | null =
    reveal !== null && reveal.location.kind === 'markdown' ? reveal.location : null;
  const initialLocation: MarkdownLocation | null =
    savedLocation !== null && savedLocation.kind === 'markdown' ? savedLocation : null;

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLocationChange = useCallback(
    (location: MarkdownLocation) => {
      const parsed = DocumentIdSchema.safeParse(documentId);
      if (!parsed.success) return;
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void call('document:setReadingPosition', { documentId: parsed.data, location }).catch(
          () => {
            // As in the PDF reader: a lost position is not worth interrupting reading over.
          },
        );
      }, POSITION_SAVE_DEBOUNCE_MS);
    },
    [documentId],
  );

  useEffect(
    () => () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    },
    [],
  );

  const createHighlight = useCallback(async () => {
    const parsed = DocumentIdSchema.safeParse(documentId);
    if (selection === null || file === null || !parsed.success) return;
    try {
      const { annotation } = await call('annotation:create', {
        documentId: parsed.data,
        kind: 'highlight',
        color: DEFAULT_HIGHLIGHT_COLOR,
        selectedText: selection.text,
        comment: null,
        anchor: createMarkdownAnchorFromSelection(selection, file.contentHash),
      });
      setSelection(null);
      await refresh();
      store.update({ selectedAnnotationId: annotation.id, selectedDocumentId: parsed.data });
      // As in the PDF reader: annotating must not resize what is being read.
      store.setStatus(`Highlighted “${truncate(selection.text, 40)}”`);
    } catch (failure) {
      store.setStatus(describeError(failure).message, 'error');
    }
  }, [documentId, file, refresh, selection, store]);

  const resolveWikilink = useCallback(
    (slug: string) => {
      const target = state.wikilinkTargets[slug];
      return target === undefined ? null : target;
    },
    [state.wikilinkTargets],
  );

  if (loading) return <EmptyState message="Opening document…" testId="markdown-panel-loading" />;
  if (error !== null) return <ErrorState message={error} testId="markdown-panel-error" />;
  if (item === null || file === null) {
    return (
      <ErrorState message="This document has no file to open." testId="markdown-panel-error" />
    );
  }

  return (
    <div className="wr-reader-panel" data-testid={`markdown-panel-${panelId}`}>
      <ReaderActions documentId={documentId} />
      {selection !== null && (
        <div className="wr-selection-bar" data-testid="selection-toolbar">
          <span className="wr-selection-bar__text">“{truncate(selection.text, 60)}”</span>
          <button
            type="button"
            className="wr-button wr-button--primary"
            data-testid="create-highlight"
            onClick={() => void createHighlight()}
          >
            Highlight
          </button>
          <button
            type="button"
            className="wr-button"
            data-testid="dismiss-selection"
            onClick={() => setSelection(null)}
          >
            Cancel
          </button>
        </div>
      )}
      <MarkdownReaderView
        documentId={documentId}
        fileUrl={file.url}
        annotations={annotations}
        selectedAnnotationId={state.selectedAnnotationId}
        initialLocation={initialLocation}
        revealLocation={revealLocation}
        onSelection={setSelection}
        onActivateHighlight={(annotationId) => {
          setEditingAnnotationId(annotationId);
          if (annotationId === null) return;
          const parsed = AnnotationIdSchema.safeParse(annotationId);
          if (parsed.success) store.update({ selectedAnnotationId: parsed.data });
        }}
        onLocationChange={onLocationChange}
        resolveWikilink={resolveWikilink}
        onWikilinkActivate={(link) => {
          const target = state.wikilinkTargets[link.slug];
          if (target === undefined) {
            store.setStatus(`“${link.target}” has not been written yet.`);
            return;
          }
          const parsed = DocumentIdSchema.safeParse(target.documentId);
          if (!parsed.success) return;
          void workbench.navigate(
            { entityId: parsed.data, entityType: 'document', documentId: parsed.data },
            'current',
          );
        }}
        onError={(message) => store.setStatus(message, 'error')}
      />
      {editing !== null && (
        <ReaderHighlightEditor
          documentId={documentId}
          annotation={editing}
          onClose={() => {
            setEditingAnnotationId(null);
          }}
        />
      )}
    </div>
  );
}

function MarkdownPanel({ params }: DockPanelProps): JSX.Element {
  const descriptor = useDescriptor(params.panelId);
  if (descriptor === null || descriptor.kind !== 'markdown-reader') {
    return <EmptyState message="This panel has nothing to show." />;
  }
  return <MarkdownPanelBody panelId={params.panelId} documentId={descriptor.documentId} />;
}

// ---------------------------------------------------------------------------
// Article reader — the saved web page
// ---------------------------------------------------------------------------

/**
 * Highlighting a saved web page (`H01`).
 *
 * The other two readers hand the panel a selection out of their own DOM. This one cannot: the
 * page is framed with `sandbox` and no tokens, so its origin is opaque and it has no script —
 * that is the whole defence against markup taken off the open web, and it is *why* the article
 * panel had no highlight flow rather than an oversight. The selection therefore arrives from
 * the main process over `webpage:selection`, which reads it out of Chromium's context-menu
 * parameters without granting the archive anything.
 *
 * What the panel does with it is ordinary: the words, the snapshot's own text, and its content
 * hash make an `HtmlAnchor` exactly as the `[W05]` suite proves one can be made, and it goes
 * over the same `annotation:create` every other highlight uses.
 *
 * `readerMode` is `'original'` here, stated rather than read off the panel descriptor. The
 * descriptor still says `'readability'` — a rendering this app does not build — and
 * `resolveHtmlAnchor` refuses to resolve across modes, so an anchor taking that field would be
 * written successfully and be permanently unresolvable afterwards.
 */
const SNAPSHOT_READER_MODE = 'original' as const;

interface SnapshotText {
  readonly text: string;
  readonly snapshotHash: string;
}

function ArticleReaderPanelBody({ panelId, documentId }: {
  readonly panelId: string;
  readonly documentId: string;
}): JSX.Element {
  const { store } = useWorkspace();
  const state = useWorkspaceState();
  const { item, file, loading, error } = useDocumentData(documentId);
  const { annotations, refresh } = useAnnotations(documentId);
  const [snapshot, setSnapshot] = useState<SnapshotText | null>(null);
  const [selection, setSelection] = useState<string | null>(null);

  // The snapshot's words, fetched once. They are the coordinate system every anchor on this
  // page lives in — both the ones being made and the ones being checked.
  useEffect(() => {
    const parsed = DocumentIdSchema.safeParse(documentId);
    if (!parsed.success) return;
    let cancelled = false;
    void (async () => {
      try {
        const answer = await call('document:getSnapshotText', { documentId: parsed.data });
        if (!cancelled) setSnapshot(answer);
      } catch {
        // A page whose text cannot be read is still readable; it just cannot be marked up.
        if (!cancelled) setSnapshot(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  useEffect(
    () =>
      subscribe('webpage:selection', (payload) => {
        if (payload.documentId !== documentId) return;
        setSelection(payload.text);
      }),
    [documentId],
  );

  const createHighlight = useCallback(async () => {
    const parsed = DocumentIdSchema.safeParse(documentId);
    if (selection === null || snapshot === null || !parsed.success) return;
    try {
      const { annotation } = await call('annotation:create', {
        documentId: parsed.data,
        kind: 'highlight',
        color: DEFAULT_HIGHLIGHT_COLOR,
        selectedText: selection,
        comment: null,
        anchor: createHtmlAnchorFromSelection(
          {
            kind: 'html',
            readerMode: SNAPSHOT_READER_MODE,
            text: selection,
            containerText: snapshot.text,
            // The selection came from outside the frame's world, so it carries no offsets.
            // `createHtmlAnchor` locates the quote in the container text itself and records
            // where it landed; the hint only breaks ties between repeated sentences, and there
            // is nothing here that knows better than "the first one".
            position: { start: 0, end: selection.length },
          },
          snapshot.snapshotHash,
        ),
      });
      setSelection(null);
      await refresh();
      store.update({ selectedAnnotationId: annotation.id, selectedDocumentId: parsed.data });
      store.setStatus(`Highlighted “${truncate(selection, 40)}”`);
    } catch (failure) {
      store.setStatus(describeError(failure).message, 'error');
    }
  }, [documentId, refresh, selection, snapshot, store]);

  // Whether each highlight is still findable in the page as it is now. The same resolution
  // the anchor was designed for, run against the text this panel already holds — a highlight
  // whose sentence was edited away says so instead of silently pointing nowhere.
  const resolved = useMemo(() => {
    const found = new Map<string, boolean>();
    if (snapshot === null) return found;
    for (const annotation of annotations) {
      if (annotation.anchor.kind !== 'html') continue;
      found.set(
        annotation.id,
        resolveHtmlAnchor({
          anchor: annotation.anchor,
          documentText: snapshot.text,
          snapshotHash: snapshot.snapshotHash,
          readerMode: SNAPSHOT_READER_MODE,
        }) !== null,
      );
    }
    return found;
  }, [annotations, snapshot]);

  if (loading) return <EmptyState message="Opening document…" testId="article-panel-loading" />;
  if (error !== null) return <ErrorState message={error} testId="article-panel-error" />;
  if (item === null || file === null) {
    return <ErrorState message="This document has no file to open." testId="article-panel-error" />;
  }

  return (
    <div className="wr-reader-panel" data-testid={`article-panel-${panelId}`}>
      <ReaderActions documentId={documentId} />
      {selection !== null && (
        <div className="wr-selection-bar" data-testid="article-selection-toolbar">
          <span className="wr-selection-bar__text">“{truncate(selection, 60)}”</span>
          <button
            type="button"
            className="wr-button wr-button--primary"
            data-testid="create-highlight"
            disabled={snapshot === null}
            onClick={() => void createHighlight()}
          >
            Highlight
          </button>
          <button
            type="button"
            className="wr-button"
            data-testid="dismiss-selection"
            onClick={() => setSelection(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {/* Beside the page, not on it. Painting a mark *inside* the archive would need script in
          the frame, which is the one thing this reader will not grant — so the highlights are
          listed against the page instead, and each says whether it still resolves. */}
      {annotations.length > 0 && (
        <div className="wr-article-highlights" data-testid="article-highlights">
          {annotations.map((annotation) => (
            <button
              key={annotation.id}
              type="button"
              className="wr-article-highlights__item"
              data-testid={`article-highlight-${annotation.id}`}
              data-resolved={resolved.get(annotation.id) === true ? 'true' : 'false'}
              aria-pressed={state.selectedAnnotationId === annotation.id}
              onClick={() => {
                const parsed = AnnotationIdSchema.safeParse(annotation.id);
                if (parsed.success) store.update({ selectedAnnotationId: parsed.data });
              }}
            >
              “{truncate(annotation.selectedText, 60)}”
            </button>
          ))}
        </div>
      )}
      <HtmlReaderView
        documentId={documentId}
        fileUrl={file.url}
        title={item.document.title}
        onError={(message) => store.setStatus(message, 'error')}
      />
    </div>
  );
}

function ArticleReaderPanel({ params }: DockPanelProps): JSX.Element {
  const descriptor = useDescriptor(params.panelId);
  if (descriptor === null || descriptor.kind !== 'article-reader') {
    return <EmptyState message="This panel has nothing to show." />;
  }
  return <ArticleReaderPanelBody panelId={params.panelId} documentId={descriptor.documentId} />;
}

// ---------------------------------------------------------------------------
// Note editor
// ---------------------------------------------------------------------------

/** How long typing stays still before the note is written back. */
const NOTE_SAVE_DEBOUNCE_MS = 500;

function NotePanelBody({ noteId }: { readonly noteId: string }): JSX.Element {
  const { store, workbench } = useWorkspace();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      setError(`Not a note id: ${noteId}`);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { note } = await call('note:get', { noteId: parsed.data });
        if (cancelled) return;
        setTitle(note.title);
        setContent(note.contentJson);
        setError(null);
      } catch (failure) {
        if (!cancelled) setError(describeError(failure).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const save = useCallback(
    (next: { title?: string; contentJson?: unknown; contentText?: string }) => {
      const parsed = NoteIdSchema.safeParse(noteId);
      if (!parsed.success) return;
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void call('note:update', { noteId: parsed.data, ...next }).catch((failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        });
      }, NOTE_SAVE_DEBOUNCE_MS);
    },
    [noteId, store],
  );

  useEffect(
    () => () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    },
    [],
  );

  const onLinkHover = useCallback(
    (link: InternalLink | null) => {
      // This is what makes F12 mean something inside a note: the workbench reads
      // `linkUnderCursor` when the command runs (criterion L02).
      store.update({ linkUnderCursor: link === null ? null : entityRefFromInternalLink(link) });
    },
    [store],
  );

  const onLinkActivate = useCallback(
    (link: InternalLink) => {
      void workbench.navigate(entityRefFromInternalLink(link), 'current');
    },
    [workbench],
  );

  if (loading) return <EmptyState message="Opening note…" />;
  if (error !== null) return <ErrorState message={error} />;

  return (
    <NoteEditorView
      noteId={noteId}
      title={title}
      content={content}
      onTitleChange={(next) => {
        setTitle(next);
        save({ title: next });
      }}
      onContentChange={(json, text) => {
        setContent(json);
        save({ contentJson: json, contentText: text });
      }}
      onLinkHover={onLinkHover}
      onLinkActivate={onLinkActivate}
      onExcerptActivate={(annotationId) => {
        const parsed = AnnotationIdSchema.safeParse(annotationId);
        if (!parsed.success) return;
        void workbench.navigate({ entityId: parsed.data, entityType: 'annotation' }, 'current');
      }}
    />
  );
}

function NotePanel({ params }: DockPanelProps): JSX.Element {
  const descriptor = useDescriptor(params.panelId);
  if (descriptor === null || descriptor.kind !== 'note-editor') {
    return <EmptyState message="This panel has nothing to show." />;
  }
  return <NotePanelBody noteId={descriptor.noteId} />;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function SearchPanel(): JSX.Element {
  const { store, workbench } = useWorkspace();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);

  const runSearch = useCallback(async () => {
    if (query.trim().length === 0) return;
    setBusy(true);
    try {
      const response = await call('search:query', { query, filters: {} });
      setResults(response.results);
      setSearched(true);
      store.setStatus(`${String(response.total)} results for ${response.normalizedQuery}`);
    } catch (failure) {
      store.setStatus(describeError(failure).message, 'error');
    } finally {
      setBusy(false);
    }
  }, [query, store]);

  return (
    <Panel testId="search-panel">
      <form
        className="wr-search__form"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <input
          className="wr-input"
          type="search"
          value={query}
          placeholder="Search the library"
          data-testid="search-input"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="wr-button wr-button--primary" data-testid="search-submit">
          Search
        </button>
      </form>
      {busy && <EmptyState message="Searching…" />}
      {!busy && searched && results.length === 0 && <EmptyState message="No results." />}
      <div className="wr-list" data-testid="search-results">
        {results.map((result) => (
          <ListRow
            key={`${result.entityType}:${result.entityId}`}
            primary={result.title}
            secondary={result.snippet}
            meta={describeLocation(result.location)}
            testId={`search-result-${result.entityId}`}
            onActivate={() => {
              // Results carry the location that produced them, which is what makes a hit
              // open the right page rather than the top of the document (criterion M10).
              if (result.documentId === null) return;
              void workbench.navigate(
                {
                  entityId: result.documentId,
                  entityType: 'document',
                  documentId: result.documentId,
                  ...(result.location === null ? {} : { location: result.location }),
                },
                'current',
              );
            }}
          />
        ))}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Lists that read straight out of the store
// ---------------------------------------------------------------------------

function AnnotationListPanel(): JSX.Element {
  return <AnnotationsView testId="annotation-list-panel" />;
}

/**
 * The annotation list, used both as a Dockview panel and as the right sidebar.
 *
 * One component for both because they are the same view of the same state; the sidebar is
 * simply the placement the workspace opens by default.
 */
export function AnnotationsView({ testId }: { readonly testId?: string }): JSX.Element {
  const { store, workbench } = useWorkspace();
  const state = useWorkspaceState();
  const documentId = state.selectedDocumentId;
  const annotations = documentId === null ? [] : (state.annotations[documentId] ?? []);
  const resolutions = useMemo(
    () => (documentId === null ? new Map() : (state.resolutions[documentId] ?? new Map())),
    [documentId, state.resolutions],
  );

  if (documentId === null) {
    return <EmptyState message="Open a document to see its annotations." testId={testId} />;
  }

  // Built per render like the inline handlers it replaces. The `[W11]` test builds it the same
  // way, so this is the one definition of what the popover's edits do.
  const edits = createAnnotationEdits(documentId, {
    call,
    setAnnotations: (id, list) => {
      store.setAnnotations(id, list);
    },
    setStatus: (text, tone) => {
      store.setStatus(text, tone);
    },
  });

  return (
    <div className="wr-sidebar-body" data-testid={testId}>
      <AnnotationList
        annotations={annotations}
        resolutions={resolutions}
        noteCounts={state.noteCounts}
        selectedAnnotationId={state.selectedAnnotationId}
        onSelect={(annotationId) => {
          const parsed = AnnotationIdSchema.safeParse(annotationId);
          if (!parsed.success) return;
          void workbench.navigate({ entityId: parsed.data, entityType: 'annotation' }, 'current');
        }}
        onAddNote={(annotationId) => {
          void addNoteToAnnotation(annotationId, workbench, store);
        }}
        onChangeColor={(annotationId, color) => {
          void edits.changeColor(annotationId, color);
        }}
        onChangeComment={(annotationId, comment) => {
          void edits.changeComment(annotationId, comment);
        }}
        onDelete={(annotationId) => {
          void edits.remove(annotationId);
        }}
        onFindReferences={(annotationId) => {
          const parsed = AnnotationIdSchema.safeParse(annotationId);
          if (!parsed.success) return;
          store.update({ selectedAnnotationId: parsed.data });
          void workbench.commands.execute(
            COMMAND_IDS.findAllReferences,
            {},
            workbench.context(),
          );
        }}
      />
    </div>
  );
}

async function addNoteToAnnotation(
  annotationId: string,
  workbench: ReturnType<typeof useWorkspace>['workbench'],
  store: ReturnType<typeof useWorkspace>['store'],
): Promise<void> {
  const parsed = AnnotationIdSchema.safeParse(annotationId);
  if (!parsed.success) return;
  try {
    const { annotation } = await call('annotation:get', { annotationId: parsed.data });
    const { note } = await call('note:create', {
      title: `Note on “${truncate(annotation.selectedText, 40)}”`,
      contentJson: null,
      contentText: '',
      attachToAnnotationId: parsed.data,
    });
    await workbench.navigate({ entityId: note.id, entityType: 'note' }, 'side');
  } catch (failure) {
    store.setStatus(describeError(failure).message, 'error');
  }
}

function OutlinePanel({ params }: DockPanelProps): JSX.Element {
  const descriptor = useDescriptor(params.panelId);
  const { workbench } = useWorkspace();
  const state = useWorkspaceState();
  const documentId =
    descriptor !== null && descriptor.kind === 'document-outline'
      ? state.selectedDocumentId
      : null;
  const [outline, setOutline] = useState<
    readonly { title: string; level: number; location: PdfLocation | { kind: string } }[]
  >([]);

  useEffect(() => {
    const parsed = documentId === null ? null : DocumentIdSchema.safeParse(documentId);
    if (parsed === null || !parsed.success) return;
    let cancelled = false;
    void call('document:getOutline', { documentId: parsed.data })
      .then((response) => {
        if (!cancelled) setOutline(response.outline);
      })
      .catch(() => {
        if (!cancelled) setOutline([]);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  if (documentId === null) return <EmptyState message="Open a document to see its outline." />;
  if (outline.length === 0) return <EmptyState message="This document has no outline." />;

  return (
    <div className="wr-list" data-testid="outline-panel">
      {outline.map((entry, index) => (
        <ListRow
          key={`${entry.title}:${String(index)}`}
          primary={entry.title}
          onActivate={() => {
            const parsed = DocumentIdSchema.safeParse(documentId);
            if (!parsed.success) return;
            void workbench.navigate(
              {
                entityId: parsed.data,
                entityType: 'document',
                documentId: parsed.data,
                location: entry.location as PdfLocation,
              },
              'current',
            );
          }}
        />
      ))}
    </div>
  );
}

/** Backlinks, references and link results all render the same resolved-link list. */
function ReferencesPanel(): JSX.Element {
  return <ReferencesView testId="references-panel" />;
}

export function ReferencesView({ testId }: { readonly testId?: string }): JSX.Element {
  const { host } = useWorkspace();
  const state = useWorkspaceState();
  const references = state.references;

  if (references === null || references.results.length === 0) {
    return <EmptyState message="No references to show." testId={testId} />;
  }

  return (
    <div className="wr-list" data-testid={testId}>
      {references.results.map((link, index) => (
        <ListRow
          key={link.id}
          primary={link.otherTitle}
          secondary={link.excerpt}
          // Every edge in this app is typed, and a list that showed only *that* two things
          // are related threw the type away at the one place a reader would look for it.
          meta={describeReference(link)}
          selected={references.selectedIndex === index}
          testId={`reference-row-${String(index)}`}
          onActivate={() => {
            // Opening a result must not close the panel — the point is to walk the list
            // (criterion L08). `openReference` navigates and leaves the panel alone.
            void host.openReference(link);
          }}
        />
      ))}
    </div>
  );
}

/**
 * What a references row says beside the title: the relationship, then where it lands.
 *
 * The direction is part of the relationship rather than decoration — "cites" and "cited by"
 * are different facts about the same edge, and the row is written from the point of view of
 * the entity the query was about.
 */
function describeReference(link: ResolvedLink): string {
  const relationship =
    link.direction === 'outgoing' ? linkTypeLabel(link.type) : `${linkTypeLabel(link.type)} this`;
  const where = describeLocation(link.otherLocation);
  return where === '' ? relationship : `${relationship} · ${where}`;
}

function LibraryPanel(): JSX.Element {
  return <LibraryView testId="library-panel" />;
}

/** How a document type reads in a list row. */
const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  pdf: 'PDF',
  webpage: 'saved page',
  markdown: 'markdown',
  note: 'note',
  other: 'other',
};

/**
 * What a row says under the title.
 *
 * Normally the authors. When two rows would read identically it is not enough: a Zotero
 * library legitimately holds the preprint *and* the published page of the same paper as two
 * separate items, and two rows differing in nothing are indistinguishable rather than
 * duplicated. The document type is what actually tells them apart, so it is added only to
 * the rows that need it — a library where every row is annotated with its type is noisier
 * for no gain.
 */
function secondaryLines(items: readonly LibraryItem[]): ReadonlyMap<string, string> {
  const byTitle = new Map<string, LibraryItem[]>();
  for (const item of items) {
    const key = item.document.title.trim().toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), item]);
  }

  const lines = new Map<string, string>();
  for (const [, group] of byTitle) {
    for (const item of group) {
      const authors = item.document.authors.map(authorLabel).join(', ');
      const ambiguous = group.length > 1;
      const qualifier = ambiguous ? DOCUMENT_TYPE_LABELS[item.document.docType] : null;
      // Qualifier first: the row truncates with an ellipsis, and a long author list pushes
      // anything after it off the end — which is exactly the case that needs telling apart.
      lines.set(
        item.document.id,
        [qualifier, authors].filter((part) => part !== null && part !== '').join(' · '),
      );
    }
  }
  return lines;
}

/**
 * Pull the Zotero library in.
 *
 * The `zotero:import` channel has existed and been tested since M04, but nothing in the
 * interface ever called it — the corpus was scanned at startup and Zotero was not, so a fresh
 * install showed an empty library with no way to fill it and no indication that importing was
 * a thing that existed. Import is explicit rather than automatic on launch because it talks
 * to another running application over the network and can take a while; a reader opening the
 * app to read should not wait on it.
 */
export function ImportFromZotero({ compact = false }: { readonly compact?: boolean } = {}): JSX.Element {
  const { busy, run } = useZoteroImport();

  return (
    <button
      type="button"
      className={compact ? 'wr-button wr-button--icon' : 'wr-button'}
      data-testid={compact ? 'import-from-zotero-compact' : 'import-from-zotero'}
      disabled={busy}
      title={busy ? 'Importing from Zotero…' : 'Import from Zotero'}
      aria-label="Import from Zotero"
      onClick={() => void run()}
    >
      {compact ? '⟳' : busy ? 'Importing…' : 'Import from Zotero'}
    </button>
  );
}

/** What an import did, in the one line the status bar has for it. */
function describeImport(summary: {
  readonly documentsCreated: number;
  readonly documentsUpdated: number;
  readonly documentsRestored: number;
  readonly itemsSeen: number;
  readonly collectionScope: string | null;
}): string {
  const from = summary.collectionScope === null ? 'Zotero' : `“${summary.collectionScope}”`;
  const parts: string[] = [];
  if (summary.documentsCreated > 0) parts.push(`${String(summary.documentsCreated)} new`);
  if (summary.documentsUpdated > 0) parts.push(`${String(summary.documentsUpdated)} updated`);
  // Said out loud: bringing a removed document back is the *point* of importing its
  // collection, and an import that reported only "nothing new" would look like it refused.
  if (summary.documentsRestored > 0) {
    parts.push(`${String(summary.documentsRestored)} back in the library`);
  }
  return parts.length === 0
    ? `Imported from ${from}: nothing new (${String(summary.itemsSeen)} items checked)`
    : `Imported from ${from}: ${parts.join(', ')}`;
}

/**
 * Run a Zotero import and say what it did.
 *
 * Shared by the library's own button and by the per-collection action in the scope picker
 * (criterion B05), because the failure everybody actually hits — Zotero not running — needs
 * the same remedy on screen wherever the import was started from.
 */
function useZoteroImport(): {
  readonly busy: boolean;
  readonly run: (options?: { readonly collection?: string }) => Promise<void>;
} {
  const { library, store } = useWorkspace();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (options: { readonly collection?: string } = {}) => {
      const { collection } = options;
      setBusy(true);
      store.setStatus(
        collection === undefined ? 'Importing from Zotero…' : `Importing “${collection}”…`,
      );
      try {
        // `collection` is sent only when one was named, so importing one collection is a
        // one-off and never writes over the remembered scope.
        const summary = await call('zotero:import', {
          force: false,
          ...(collection === undefined ? {} : { collection }),
        });
        store.setStatus(describeImport(summary));
        library.reload();
      } catch (failure) {
        // The overwhelmingly common cause is Zotero not running, and the raw connection error
        // does not say so. The remedy is what belongs on screen.
        const { message } = describeError(failure);
        store.setStatus(
          /ECONNREFUSED|fetch failed|connect/i.test(message)
            ? 'Could not reach Zotero. Open Zotero and try again — it serves the local API only while running.'
            : message,
          'error',
        );
      } finally {
        setBusy(false);
      }
    },
    [library, store],
  );

  return { busy, run };
}

/**
 * Pick which Zotero collections an import covers.
 *
 * Scoping the import has worked since `W12`, but only as an argument nobody could supply: the
 * button imported the whole library, which for a fifteen-year Zotero is fifteen years of
 * everything and a first run that never ends. The picks are held in the main process, not in
 * this component — an import started from anywhere uses them, and they are still there after
 * a restart.
 *
 * Nothing ticked means the whole library, which is both the default and what the summary
 * line says, so "no scope" never reads as "nothing will be imported".
 *
 * Each row also imports *its* collection in one action (criterion B05). That is the other
 * half of what a removal means: taking a paper out of the library says "not now", and naming
 * the collection it came from is how the researcher asks for it back (criterion B01). It is
 * a separate control from the tick, because a scope is a standing decision and an import is
 * something that happens once, when it is pressed.
 */
export function ZoteroScopePicker(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<readonly CollectionOption[]>([]);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const { store } = useWorkspace();
  const { busy: importing, run: runImport } = useZoteroImport();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, scope] = await Promise.all([
        call('zotero:listCollections', {}),
        call('zotero:getImportScope', {}),
      ]);
      setOptions(list.collections);
      setPicked(scope.collections);
      setNote(list.message);
    } catch (failure) {
      setNote(describeError(failure).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // The remembered picks are read whether or not the picker is open: the summary line is how
  // someone finds out an import is scoped without having to go looking for the reason.
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (name: string) => {
      const next = picked.includes(name)
        ? picked.filter((entry) => entry !== name)
        : [...picked, name];
      setPicked(next);
      try {
        const saved = await call('zotero:setImportScope', { collections: next });
        setPicked(saved.collections);
      } catch (failure) {
        store.setStatus(describeError(failure).message, 'error');
        void load();
      }
    },
    [load, picked, store],
  );

  const summary =
    picked.length === 0
      ? 'Importing the whole library'
      : `Importing ${picked.length === 1 ? '1 collection' : `${String(picked.length)} collections`}`;

  return (
    <div className="wr-scope" data-testid="zotero-scope">
      <button
        type="button"
        className="wr-scope__summary"
        data-testid="zotero-scope-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void load();
        }}
      >
        <span data-testid="zotero-scope-summary">{summary}</span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="wr-scope__body" data-testid="zotero-scope-picker">
          {note !== '' && <p className="wr-scope__note">{note}</p>}
          {loading && options.length === 0 && <p className="wr-scope__note">Loading collections…</p>}
          {!loading && options.length === 0 && (
            <p className="wr-scope__note" data-testid="zotero-scope-empty">
              No collections to pick from yet.
            </p>
          )}
          {options.map((option) => (
            <div
              key={option.label}
              className="wr-scope__option"
              data-testid="zotero-scope-option"
              data-collection={option.name}
            >
              <label
                className="wr-scope__pick"
                title={option.ambiguous ? 'Two collections share this name — rename one in Zotero' : option.label}
              >
                <input
                  type="checkbox"
                  checked={picked.includes(option.name)}
                  disabled={option.ambiguous}
                  onChange={() => void toggle(option.name)}
                />
                <span>{option.label}</span>
              </label>
              {/* Ticking is a *scope* — what future imports cover — and this is one import,
                  now. Two different gestures, so two different controls: the button leaves
                  the remembered picks alone, and the checkbox starts nothing. */}
              <button
                type="button"
                className="wr-button wr-button--quiet wr-scope__import"
                data-testid="zotero-scope-import"
                data-collection={option.name}
                disabled={importing || option.ambiguous}
                title={`Import “${option.name}” from Zotero now. Anything removed from it comes back.`}
                aria-label={`Import ${option.name} from Zotero`}
                onClick={() => void runImport({ collection: option.name })}
              >
                Import
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Which folder the notes come from, and the way to change it.
 *
 * The renderer asks for the choice to be *made* and is told the folder's name; the dialog,
 * the path and everything the change does live in the main process. A channel that took a
 * path would be an arbitrary-directory read wearing a preference's clothes.
 */
export function NotesFolderControl(): JSX.Element {
  const { library, store } = useWorkspace();
  const [folderName, setFolderName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await call('corpus:folder', {});
        if (!cancelled) setFolderName(status.folderName);
      } catch {
        // The folder's name is a caption, not the feature. A failure here must not take the
        // library list down with it.
        if (!cancelled) setFolderName(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [library.notes]);

  const choose = useCallback(async () => {
    setBusy(true);
    try {
      const result = await call('corpus:chooseFolder', {});
      setFolderName(result.folderName);
      if (result.changed) {
        store.setStatus(
          result.purged === 0
            ? `Notes folder is now ${result.folderName} — ${String(result.documentsCreated)} added`
            : `Notes folder is now ${result.folderName} — ${String(result.documentsCreated)} added, ${String(result.purged)} from the old folder removed`,
        );
        library.reload();
      }
    } catch (failure) {
      store.setStatus(describeError(failure).message, 'error');
    } finally {
      setBusy(false);
    }
  }, [library, store]);

  return (
    <div className="wr-notes-folder" data-testid="notes-folder">
      <span className="wr-notes-folder__name" data-testid="notes-folder-name">
        {folderName ?? '—'}
      </span>
      <button
        type="button"
        className="wr-button wr-button--quiet"
        data-testid="notes-folder-choose"
        disabled={busy}
        onClick={() => void choose()}
      >
        {busy ? 'Choosing…' : 'Change folder…'}
      </button>
    </div>
  );
}

/**
 * Add files from the disk (criterion B02).
 *
 * The dialog belongs to the main process and so do the paths it returns: this asks for the
 * choice to be *made* and is told how many arrived. A channel that took a path would let a
 * compromised renderer name any file on the machine and read it back over `rrfile://`.
 */
function AddFilesControl(): JSX.Element {
  const { library, store } = useWorkspace();
  const [busy, setBusy] = useState(false);

  const add = useCallback(async () => {
    setBusy(true);
    try {
      const result = await call('library:addFiles', {});
      if (!result.chose) {
        // A cancelled dialog is not a failure, and background mode refuses to open one at
        // all — saying nothing there would look like the button was broken.
        store.setStatus('No files were added.');
        return;
      }
      store.setStatus(
        result.failed === 0
          ? `Added ${String(result.added)} to the library`
          : `Added ${String(result.added)} to the library — ${String(result.failed)} could not be read`,
      );
      library.reload();
    } catch (failure) {
      store.setStatus(describeError(failure).message, 'error');
    } finally {
      setBusy(false);
    }
  }, [library, store]);

  return (
    <button
      type="button"
      className="wr-button wr-button--quiet"
      data-testid="library-add-files"
      disabled={busy}
      title="Add files from this computer to the library"
      onClick={() => void add()}
    >
      {busy ? 'Adding…' : 'Add files…'}
    </button>
  );
}

/** Take a document out of the library, saying what the removal is not taking with it. */
function RemoveFromLibrary({ item }: { readonly item: LibraryItem }): JSX.Element {
  const { library, store } = useWorkspace();
  const [busy, setBusy] = useState(false);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      const result = await call('library:removeDocument', { documentId: item.document.id });
      const kept = result.annotationsKept + result.linksKept;
      // What was kept, and the way back — a removal means "not now", and the researcher is
      // told where "again" lives rather than being left to guess it is gone for good.
      store.setStatus(
        kept === 0
          ? `Removed “${item.document.title}” — import its collection again to bring it back`
          : `Removed “${item.document.title}” — ${String(result.annotationsKept)} highlights and ${String(result.linksKept)} links kept; import its collection again to bring it back`,
      );
      library.reload();
    } catch (failure) {
      store.setStatus(describeError(failure).message, 'error');
    } finally {
      setBusy(false);
    }
  }, [item, library, store]);

  return (
    <button
      type="button"
      className="wr-button wr-button--quiet"
      data-testid={`library-remove-${item.document.id}`}
      disabled={busy}
      title={`Remove “${item.document.title}” from the library. Zotero is not touched.`}
      aria-label={`Remove ${item.document.title} from the library`}
      onClick={() => void remove()}
    >
      Remove
    </button>
  );
}

/** The library list, shared by the sidebar and the Dockview library panel. */
export function LibraryView({ testId }: { readonly testId?: string }): JSX.Element {
  const { library, openDocument } = useWorkspace();
  const state = useWorkspaceState();

  const secondary = useMemo(() => secondaryLines(library.items), [library.items]);

  if (library.loading) return <EmptyState message="Loading library…" testId={testId} />;
  if (library.error !== null) return <ErrorState message={library.error} testId={testId} />;

  return (
    // The whole library accepts a drop, which is what `data-wr-drop-library` marks. The
    // preload reads the attribute off the ancestor of whatever the file landed on, resolves
    // the path with `webUtils.getPathForFile`, and sends it on a channel this page cannot
    // address — so the path never exists in the renderer's world at all (criterion B02).
    <div className="wr-sidebar-body" data-testid={testId} data-wr-drop-library="">
      {/* Above the list, and rendered even when the library is empty: an install with
          nothing in it is exactly when someone needs to say what to import and from where. */}
      <ZoteroScopePicker />

      <div className="wr-list" data-testid="library-zotero-list">
        {library.items.length === 0 ? (
          <div className="wr-state" data-testid="library-empty">
            <p className="wr-state__message">Nothing imported from Zotero yet.</p>
            <p className="wr-state__hint">Zotero must be running — it serves its local API only while open.</p>
            <div className="wr-state__action">
              <ImportFromZotero />
            </div>
          </div>
        ) : (
          library.items.map((item) => (
            <ListRow
              key={item.document.id}
              primary={item.document.title}
              secondary={secondary.get(item.document.id)}
              meta={item.annotationCount > 0 ? String(item.annotationCount) : undefined}
              selected={state.selectedDocumentId === item.document.id}
              testId={`library-item-${item.document.id}`}
              title={item.document.title}
              onActivate={() => void openDocument(item.document.id, 'current')}
              onActivateToSide={() => void openDocument(item.document.id, 'side')}
              action={<RemoveFromLibrary item={item} />}
            />
          ))
        )}
      </div>

      {/* Zotero is one source of documents, not the definition of the library. The heading
          carries the way in, and says the other one — a drop — exists, because a drop target
          nothing names is a feature only its author knows about. */}
      <h3 className="wr-list__section" data-testid="local-section-heading">
        From disk
        {library.added.length > 0 && (
          <span className="wr-list__section-count">{library.added.length}</span>
        )}
        <AddFilesControl />
      </h3>
      <p className="wr-list__hint" data-testid="library-drop-hint">
        Drop files here to add them. They stay where they are on disk.
      </p>
      {library.added.length > 0 && (
        <div className="wr-list" data-testid="library-local-list">
          {library.added.map((item) => (
            <ListRow
              key={item.document.id}
              primary={item.document.title}
              meta={item.annotationCount > 0 ? String(item.annotationCount) : undefined}
              selected={state.selectedDocumentId === item.document.id}
              testId={`library-item-${item.document.id}`}
              title={item.document.title}
              onActivate={() => void openDocument(item.document.id, 'current')}
              onActivateToSide={() => void openDocument(item.document.id, 'side')}
              action={<RemoveFromLibrary item={item} />}
            />
          ))}
        </div>
      )}

      {/* The heading carries the folder control, so "these notes come from somewhere, and
          you can say where" is one thing rather than a preference in another window. It is
          rendered with no notes under it too: an empty notes section usually means the
          folder is wrong, and that is the moment to be able to change it. */}
      <h3 className="wr-list__section" data-testid="notes-section-heading">
        Notes
        {library.notes.length > 0 && (
          <span className="wr-list__section-count">{library.notes.length}</span>
        )}
        <NotesFolderControl />
      </h3>
      {library.notes.length > 0 && (
        <>
          <div className="wr-list" data-testid="library-notes-list">
            {library.notes.map((item) => (
              <ListRow
                key={item.document.id}
                primary={item.document.title}
                secondary={item.document.slug ?? undefined}
                meta={item.annotationCount > 0 ? String(item.annotationCount) : undefined}
                selected={state.selectedDocumentId === item.document.id}
                testId={`library-item-${item.document.id}`}
                title={item.document.title}
                onActivate={() => void openDocument(item.document.id, 'current')}
                onActivateToSide={() => void openDocument(item.document.id, 'side')}
              />
            ))}
          </div>
        </>
      )}

      {/* No "Removed" section. A removal means "not now", and Zotero is still the shelf the
          paper came from: importing its collection brings it back with its highlights
          (criterion B01). A list of removed things here would be a blacklist to curate — one
          more list to keep tidy, in an application whose point is to have fewer of them. */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The component map Dockview is configured with
// ---------------------------------------------------------------------------

export const DOCKVIEW_COMPONENTS: Record<string, React.FunctionComponent<DockPanelProps>> = {
  library: LibraryPanel,
  'pdf-reader': PdfPanel,
  'article-reader': ArticleReaderPanel,
  'markdown-reader': MarkdownPanel,
  'search-results': SearchPanel,
  'annotation-list': AnnotationListPanel,
  'note-editor': NotePanel,
  'document-outline': OutlinePanel,
  backlinks: ReferencesPanel,
  references: ReferencesPanel,
  'link-results': ReferencesPanel,
  'link-graph': GraphPanel,
  wiki: WikiPanel,
  focus: FocusPanel,
  notebook: NotebookPanel,
  'notebook-directory': NotebookDirectoryPanel,
  journal: JournalPanel,
};
