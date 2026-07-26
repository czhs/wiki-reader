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
import { AnnotationList } from '@wr/annotations';
import { NoteEditorView } from '@wr/note-editor';
import { PdfReaderView, createPdfAnchorFromSelection } from '@wr/pdf-reader';
import { MarkdownReaderView, createMarkdownAnchorFromSelection } from '@wr/markdown-reader';
import { HtmlReaderView } from '@wr/html-reader';
import { EmptyState, ErrorState, ListRow, Panel } from '@wr/shared-ui';
import { COMMAND_IDS, entityRefFromInternalLink, type PanelDescriptor } from '@wr/workbench';
import { describeLocation } from '@wr/document-model';
import {
  AnnotationIdSchema,
  DEFAULT_HIGHLIGHT_COLOR,
  DocumentIdSchema,
  NoteIdSchema,
  type Author,
  type InternalLink,
  type MarkdownLocation,
  type MarkdownReaderSelection,
  type PdfLocation,
  type PdfReaderSelection,
  type ResolvedLocation,
  type SearchResult,
} from '@wr/shared-types';
import { createAnnotationEdits } from './annotation-actions.js';
import { useAnnotations, useDocumentData } from './document-data.js';
import { GraphPanel } from './graph-panel.js';
import { call, describeError } from './ipc.js';
import { useWorkspace, useWorkspaceState } from './workspace.js';

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
        onLocationChange={onLocationChange}
        onResolutions={onResolutions}
        onError={(message) => store.setStatus(message, 'error')}
      />
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

function ArticleReaderPanelBody({ panelId, documentId }: {
  readonly panelId: string;
  readonly documentId: string;
}): JSX.Element {
  const { store } = useWorkspace();
  const { item, file, loading, error } = useDocumentData(documentId);

  if (loading) return <EmptyState message="Opening document…" testId="article-panel-loading" />;
  if (error !== null) return <ErrorState message={error} testId="article-panel-error" />;
  if (item === null || file === null) {
    return <ErrorState message="This document has no file to open." testId="article-panel-error" />;
  }

  return (
    <div className="wr-reader-panel" data-testid={`article-panel-${panelId}`}>
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
          meta={describeLocation(link.otherLocation)}
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

function LibraryPanel(): JSX.Element {
  return <LibraryView testId="library-panel" />;
}

/** The library list, shared by the sidebar and the Dockview library panel. */
export function LibraryView({ testId }: { readonly testId?: string }): JSX.Element {
  const { library, openDocument } = useWorkspace();
  const state = useWorkspaceState();

  if (library.loading) return <EmptyState message="Loading library…" testId={testId} />;
  if (library.error !== null) return <ErrorState message={library.error} testId={testId} />;
  if (library.items.length === 0) {
    return <EmptyState message="No documents imported yet." testId={testId} />;
  }

  return (
    <div className="wr-list" data-testid={testId}>
      {library.items.map((item) => (
        <ListRow
          key={item.document.id}
          primary={item.document.title}
          secondary={item.document.authors.map(authorLabel).join(', ')}
          meta={item.annotationCount > 0 ? String(item.annotationCount) : undefined}
          selected={state.selectedDocumentId === item.document.id}
          testId={`library-item-${item.document.id}`}
          title={item.document.title}
          onActivate={() => void openDocument(item.document.id, 'current')}
          onActivateToSide={() => void openDocument(item.document.id, 'side')}
        />
      ))}
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
};
