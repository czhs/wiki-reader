import { z } from 'zod';
import {
  DocumentIdSchema,
  DocumentLocationSchema,
  NavigationLocationSchema,
  NoteIdSchema,
  AnnotationIdSchema,
  SearchFiltersSchema,
  type Timestamp,
  type WorkspaceLayout,
} from '@wr/shared-types';

/**
 * Workspace layout serialization.
 *
 * Dockview owns the geometry — which groups exist, how they are split, which tab is
 * active — and hands it to us as an opaque blob. We own everything Dockview cannot know:
 * which document each panel shows, where the reader was scrolled, what the search query
 * was, and the navigation history.
 *
 * The Dockview blob stays `unknown` on purpose. Reaching into it would couple layout
 * persistence to a Dockview version, and it round-trips fine as JSON.
 *
 * Deserialization is total. A layout is a convenience, never data the user typed, so a
 * corrupt or stale blob must degrade to "open with a fresh workspace" instead of throwing
 * on startup and bricking the app.
 */

export const WORKSPACE_LAYOUT_VERSION = 1;
export const DEFAULT_WORKSPACE_NAME = 'default';

export const PANEL_KINDS = [
  'library',
  /**
   * What next — the queue of notebooks in front (`U15`).
   *
   * It was the second occupant of the left slot. The slot is gone: the activity bar launches
   * tabs now, so the shelf of what to do next is a page like every other surface, and the
   * reading keeps the whole window when it is not being looked at.
   */
  'queue',
  'pdf-reader',
  'article-reader',
  'markdown-reader',
  'search-results',
  'annotation-list',
  'note-editor',
  'document-outline',
  'backlinks',
  'references',
  'link-results',
  'link-graph',
  'wiki',
  'ledger',
  'notebook',
  'notebook-directory',
  'journal',
  'help',
  'guide',
] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];

/** Panels that present a document and can therefore be a navigation target. */
export const READER_PANEL_KINDS = ['pdf-reader', 'article-reader', 'markdown-reader'] as const;
export type ReaderPanelKind = (typeof READER_PANEL_KINDS)[number];

export function isReaderPanelKind(kind: PanelKind): kind is ReaderPanelKind {
  return (READER_PANEL_KINDS as readonly PanelKind[]).includes(kind);
}

// ---------------------------------------------------------------------------
// Panel descriptors
// ---------------------------------------------------------------------------

const PanelIdSchema = z.string().min(1);

export const LibraryPanelSchema = z.object({
  kind: z.literal('library'),
  selectedDocumentId: DocumentIdSchema.nullable().default(null),
  expandedCollectionIds: z.array(z.string().min(1)).default([]),
});

/**
 * What next (`U15`).
 *
 * Stateless: what it lists is the queue as it is now, re-read when the panel mounts. The
 * hand-arranged order lives with the notebooks themselves, never on a tab.
 */
export const QueuePanelSchema = z.object({
  kind: z.literal('queue'),
});

export const PdfReaderPanelSchema = z.object({
  kind: z.literal('pdf-reader'),
  documentId: DocumentIdSchema,
  /** Where the reader was when the workspace was saved. Restored on reopen. */
  location: DocumentLocationSchema.nullable().default(null),
  zoom: z.number().positive().nullable().default(null),
});

export const ArticleReaderPanelSchema = z.object({
  kind: z.literal('article-reader'),
  documentId: DocumentIdSchema,
  location: DocumentLocationSchema.nullable().default(null),
  readerMode: z.enum(['readability', 'original']).default('readability'),
  /**
   * How much bigger than the fit this panel shows the page (`V04`), or null for the fit.
   *
   * Per panel and not a setting, the same shape as the PDF reader's zoom above: the researcher
   * reads at most two of these side by side, and the one at half a screen wants a different
   * lever from the one that has the window.
   */
  zoom: z.number().positive().nullable().default(null),
});

export const MarkdownReaderPanelSchema = z.object({
  kind: z.literal('markdown-reader'),
  documentId: DocumentIdSchema,
  location: DocumentLocationSchema.nullable().default(null),
});

export const SearchResultsPanelSchema = z.object({
  kind: z.literal('search-results'),
  query: z.string().default(''),
  filters: SearchFiltersSchema.nullable().default(null),
  selectedResultIndex: z.number().int().nonnegative().nullable().default(null),
});

export const AnnotationListPanelSchema = z.object({
  kind: z.literal('annotation-list'),
  documentId: DocumentIdSchema.nullable().default(null),
  selectedAnnotationId: AnnotationIdSchema.nullable().default(null),
});

export const NoteEditorPanelSchema = z.object({
  kind: z.literal('note-editor'),
  noteId: NoteIdSchema,
  location: DocumentLocationSchema.nullable().default(null),
});

export const DocumentOutlinePanelSchema = z.object({
  kind: z.literal('document-outline'),
  documentId: DocumentIdSchema.nullable().default(null),
});

export const BacklinksPanelSchema = z.object({
  kind: z.literal('backlinks'),
  entityId: z.string().min(1).nullable().default(null),
  entityType: z.string().min(1).nullable().default(null),
});

export const ReferencesPanelSchema = z.object({
  kind: z.literal('references'),
  entityId: z.string().min(1).nullable().default(null),
  entityType: z.string().min(1).nullable().default(null),
  selectedIndex: z.number().int().nonnegative().nullable().default(null),
});

export const LinkResultsPanelSchema = z.object({
  kind: z.literal('link-results'),
  linkType: z.string().min(1).nullable().default(null),
  groupBy: z
    .enum(['source-document', 'target-document', 'link-type', 'direction', 'entity-type'])
    .default('link-type'),
  selectedIndex: z.number().int().nonnegative().nullable().default(null),
});

/**
 * The graph view, always opened *on* something.
 *
 * The seed is the panel's whole state because it is the whole question: the main process
 * answers with the neighbourhood around it, and the panel holds no graph of its own to
 * restore. A restored panel re-asks and gets what is true now.
 *
 * How wide, how spread out and whether to label is deliberately *not* here. Those are one
 * view of graphs in general rather than one per panel, so they are persisted settings the
 * panel reads (`G02`) — keeping a copy of the depth on the descriptor would make a second
 * authority that drifts the moment either is changed alone.
 */
export const LinkGraphPanelSchema = z.object({
  kind: z.literal('link-graph'),
  seedEntityId: z.string().min(1).nullable().default(null),
  seedEntityType: z.string().min(1).nullable().default(null),
});

/**
 * The wiki: the library seen at once, or focused on one file (`F01`, `F02`, `F03`, `F05`).
 *
 * One surface with two states, not two surfaces. It shipped as two — a stateless wiki page and
 * a `focus` panel carrying a file — and the comment here said so, on the grounds that "the
 * whole library, ranked" and "one hop around this" cannot be the same layout. They still are
 * not the same layout; what was wrong was making them two *tabs*. A researcher who focuses on
 * a paper from the map and then wants the map back was closing one page and opening another,
 * and the two accumulated their own viewports, their own tabs and their own places in the
 * workspace. So the file being focused on is a state of this descriptor, null for the whole
 * library, and the surface draws whichever the state says.
 *
 * What it shows is otherwise re-read when it mounts, because a map that restored a remembered
 * library would be drawing the shelf as it was.
 *
 * The focused file changes as the view is crawled (`F03`) — this is the one descriptor a panel
 * rewrites under itself. Persisting it is what makes a crawl survive a restart: reopening lands
 * where the reading got to, rather than back at whichever file the view was first opened on.
 *
 * Deliberately still not the graph panel with a null seed: the graph panel is a sidecar opened
 * *on* something and stays beside what is being read, and this is a page.
 */
export const WikiPanelSchema = z.object({
  kind: z.literal('wiki'),
  /**
   * The file the map is focused on, or null for the whole library.
   *
   * A plain string, the way the graph panel's seed is: the id arrives from an `EntityRef`,
   * which link results and IPC answers hand over as opaque text. It is parsed into a
   * `DocumentId` at the point it is used to ask a question, so a descriptor restored from a
   * stale workspace opens the whole library rather than failing the whole restore.
   */
  focusDocumentId: z.string().min(1).nullable().default(null),
});

/**
 * A file's ledger: every link on it and on the sentences marked in it (`H03`).
 *
 * The file is the panel's whole state, like the focused view's, and for the same reason — what
 * it shows is re-read when it mounts, because a restored ledger holding a remembered list would
 * be showing relationships that may since have been made or unmade.
 */
export const LedgerPanelSchema = z.object({
  kind: z.literal('ledger'),
  /** A plain string for the reason `WikiPanelSchema` gives about its focused file. */
  documentId: z.string().min(1).nullable().default(null),
});

/**
 * A field notebook.
 *
 * The notebook id is the panel's whole state: the page, its front matter and its claims are
 * re-read from the main process when the panel mounts, so a restored notebook shows what is
 * true now rather than a copy of what was on screen when the workspace was saved.
 */
export const NotebookPanelSchema = z.object({
  kind: z.literal('notebook'),
  questionId: z.string().min(1),
});

/**
 * The directory: every notebook in the library, and the way in to each one (`P01`).
 *
 * Stateless. What it lists is re-read when it mounts, because a directory that restored a
 * remembered list would be showing the shelf as it was rather than as it is.
 */
export const NotebookDirectoryPanelSchema = z.object({
  kind: z.literal('notebook-directory'),
});

/**
 * A notebook's journal (criteria N09, P02).
 *
 * It carries the notebook whose log it is and nothing else. The day being read is
 * deliberately not on it: a journal opens on today — that is what the page is for — and which
 * day you happened to be looking at when the app was last closed is a reading position, not a
 * layout. Persisting it would mean a workspace restored on Tuesday opens on Monday and
 * quietly writes there.
 */
export const JournalPanelSchema = z.object({
  kind: z.literal('journal'),
  questionId: z.string().min(1),
});

/**
 * The help page (`D02`).
 *
 * Stateless, and it has to be: what it lists is the command and keybinding registries, read
 * when it mounts. A descriptor carrying a copy of them would be a second authority — the exact
 * failure the criterion names, one restart later.
 */
export const HelpPanelSchema = z.object({
  kind: z.literal('help'),
});

/**
 * The guide (`O01`).
 *
 * Stateless for the same reason the help page is, and one further one: what it covers is
 * computed from the command registry when it mounts, so a descriptor that carried a chapter
 * list would be able to describe an app that no longer exists. Which chapter is open is a
 * reading position rather than a layout, and the page is short enough to scroll.
 */
export const GuidePanelSchema = z.object({
  kind: z.literal('guide'),
});

export const PanelDescriptorSchema = z.discriminatedUnion('kind', [
  LibraryPanelSchema,
  QueuePanelSchema,
  PdfReaderPanelSchema,
  ArticleReaderPanelSchema,
  MarkdownReaderPanelSchema,
  SearchResultsPanelSchema,
  AnnotationListPanelSchema,
  NoteEditorPanelSchema,
  DocumentOutlinePanelSchema,
  BacklinksPanelSchema,
  ReferencesPanelSchema,
  LinkResultsPanelSchema,
  LinkGraphPanelSchema,
  WikiPanelSchema,
  LedgerPanelSchema,
  NotebookPanelSchema,
  NotebookDirectoryPanelSchema,
  JournalPanelSchema,
  HelpPanelSchema,
  GuidePanelSchema,
]);
export type PanelDescriptor = z.infer<typeof PanelDescriptorSchema>;

export type PdfReaderPanel = z.infer<typeof PdfReaderPanelSchema>;
export type ArticleReaderPanel = z.infer<typeof ArticleReaderPanelSchema>;
export type MarkdownReaderPanel = z.infer<typeof MarkdownReaderPanelSchema>;
export type NoteEditorPanel = z.infer<typeof NoteEditorPanelSchema>;
export type ReferencesPanel = z.infer<typeof ReferencesPanelSchema>;
export type WikiPanel = z.infer<typeof WikiPanelSchema>;

/** Any descriptor that presents a document, and so carries a `documentId` and a `location`. */
export type ReaderPanel = Extract<PanelDescriptor, { kind: ReaderPanelKind }>;

/**
 * Narrow a descriptor to a reader.
 *
 * `isReaderPanelKind` only narrows the *kind*; TypeScript will not carry that back to the
 * descriptor it came from, so reading `descriptor.documentId` after it still fails. Callers
 * that want the fields want this one.
 */
export function isReaderPanel(descriptor: PanelDescriptor): descriptor is ReaderPanel {
  return isReaderPanelKind(descriptor.kind);
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export const NavigationHistoryStateSchema = z.object({
  entries: z.array(NavigationLocationSchema).default([]),
  cursor: z.number().int().default(-1),
});
export type NavigationHistoryState = z.infer<typeof NavigationHistoryStateSchema>;

export const SerializedWorkspaceSchema = z.object({
  version: z.literal(WORKSPACE_LAYOUT_VERSION),
  /** Dockview's own `SerializedDockview`. Opaque by design. */
  dockview: z.unknown(),
  panels: z.record(PanelIdSchema, PanelDescriptorSchema).default({}),
  activePanelId: PanelIdSchema.nullable().default(null),
  history: NavigationHistoryStateSchema.default({ entries: [], cursor: -1 }),
});
export type SerializedWorkspace = z.infer<typeof SerializedWorkspaceSchema>;

export function emptyWorkspace(): SerializedWorkspace {
  return {
    version: WORKSPACE_LAYOUT_VERSION,
    dockview: null,
    panels: {},
    activePanelId: null,
    history: { entries: [], cursor: -1 },
  };
}

export interface WorkspaceSerializationInput {
  readonly dockview: unknown;
  readonly panels: Readonly<Record<string, PanelDescriptor>>;
  readonly activePanelId?: string | null;
  readonly history?: NavigationHistoryState;
}

/**
 * Build the serialized form. Panels referenced by `activePanelId` but absent from `panels`
 * are dropped rather than persisted, so a restore never activates a panel it cannot build.
 */
export function serializeWorkspace(input: WorkspaceSerializationInput): SerializedWorkspace {
  const panels: Record<string, PanelDescriptor> = { ...input.panels };
  const requestedActive = input.activePanelId ?? null;
  const activePanelId =
    requestedActive !== null && Object.hasOwn(panels, requestedActive) ? requestedActive : null;

  return {
    version: WORKSPACE_LAYOUT_VERSION,
    dockview: input.dockview,
    panels,
    activePanelId,
    history: input.history ?? { entries: [], cursor: -1 },
  };
}

export type WorkspaceDeserializeResult =
  | { readonly ok: true; readonly workspace: SerializedWorkspace; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a persisted workspace.
 *
 * Individual unparseable panels are dropped with a warning instead of failing the whole
 * restore: a single stale panel kind from an older build should cost the user one tab, not
 * their entire layout. A payload that is not a workspace at all fails cleanly.
 */
export function deserializeWorkspace(raw: unknown): WorkspaceDeserializeResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: 'workspace layout is not an object' };
  }

  const version = (raw as { version?: unknown }).version;
  if (version !== WORKSPACE_LAYOUT_VERSION) {
    return {
      ok: false,
      error: `unsupported workspace layout version ${JSON.stringify(version)}; expected ${WORKSPACE_LAYOUT_VERSION}`,
    };
  }

  const warnings: string[] = [];

  // Salvage the panel map entry by entry before validating the envelope.
  const rawPanels = (raw as { panels?: unknown }).panels;
  const panels: Record<string, PanelDescriptor> = {};
  if (rawPanels !== undefined && rawPanels !== null) {
    if (typeof rawPanels !== 'object') {
      return { ok: false, error: 'workspace `panels` is not an object' };
    }
    for (const [panelId, value] of Object.entries(rawPanels as Record<string, unknown>)) {
      const parsed = PanelDescriptorSchema.safeParse(value);
      if (parsed.success) panels[panelId] = parsed.data;
      else warnings.push(`dropped panel \`${panelId}\`: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    }
  }

  const envelope = SerializedWorkspaceSchema.safeParse({ ...(raw as object), panels });
  if (!envelope.success) {
    return { ok: false, error: `invalid workspace layout: ${envelope.error.issues[0]?.message ?? 'unknown'}` };
  }

  // A workspace saved before `U15` carries `sidebars` and `chrome`. The schema is not strict,
  // so those keys are dropped here rather than failing the restore: the researcher keeps the
  // tabs they had arranged, and the furniture that no longer exists goes quietly.
  const workspace = envelope.data;

  if (workspace.activePanelId !== null && !Object.hasOwn(workspace.panels, workspace.activePanelId)) {
    warnings.push(`active panel \`${workspace.activePanelId}\` no longer exists`);
    return { ok: true, workspace: { ...workspace, activePanelId: null }, warnings };
  }

  return { ok: true, workspace, warnings };
}

/** Round-trip through JSON, the way the layout actually reaches SQLite. */
export function workspaceToJson(workspace: SerializedWorkspace): string {
  return JSON.stringify(workspace);
}

export function workspaceFromJson(text: string): WorkspaceDeserializeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `workspace layout is not valid JSON: ${String(error)}` };
  }
  return deserializeWorkspace(raw);
}

// ---------------------------------------------------------------------------
// Bridge to the persisted domain record
// ---------------------------------------------------------------------------

/**
 * Convert to the `WorkspaceLayout` row shape. `panelState` is kept as a separate column in
 * the domain model, so the Dockview blob and our panel map are stored side by side rather
 * than nested, which keeps the row inspectable in a SQLite browser.
 */
export function toWorkspaceLayoutRecord(
  workspace: SerializedWorkspace,
  updatedAt: Timestamp,
  name: string = DEFAULT_WORKSPACE_NAME,
): WorkspaceLayout {
  return {
    name,
    layout: workspace.dockview,
    panelState: {
      version: workspace.version,
      panels: workspace.panels,
      activePanelId: workspace.activePanelId,
      history: workspace.history,
    },
    updatedAt,
  };
}

/** Inverse of `toWorkspaceLayoutRecord`. Total: a corrupt row yields a clean error. */
export function fromWorkspaceLayoutRecord(record: WorkspaceLayout): WorkspaceDeserializeResult {
  const state = record.panelState;
  if (state === null || typeof state !== 'object') {
    return { ok: false, error: 'workspace `panelState` is not an object' };
  }
  return deserializeWorkspace({ ...(state as object), dockview: record.layout });
}
