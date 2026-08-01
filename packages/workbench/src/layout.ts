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
  'focus',
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
 * The wiki: the library seen at once (`F01`).
 *
 * Stateless, like the directory and for the same reason — what it shows is re-read when it
 * mounts, because a map that restored a remembered library would be drawing the shelf as it
 * was. Deliberately not the graph panel with a null seed: the graph panel is a sidecar opened
 * *on* something, and this is a page. Two surfaces, not one with a toggle.
 */
export const WikiPanelSchema = z.object({
  kind: z.literal('wiki'),
});

/**
 * The focused view: one file, its highlights, and where it leads (`F02`, `F03`).
 *
 * The file on the descriptor is the *current* focus and changes as the view is crawled — which
 * is what `F03` asks for and why this is the one descriptor a panel rewrites under itself.
 * Persisting it is what makes the crawl survive a restart: reopening lands where the reading
 * got to, rather than back at whichever file the view was first opened on.
 *
 * How the view is drawn is not here, for the reason `LinkGraphPanelSchema` gives.
 */
export const FocusPanelSchema = z.object({
  kind: z.literal('focus'),
  /**
   * A plain string, the way the graph panel's seed is: the id arrives from an `EntityRef`,
   * which link results and IPC answers hand over as opaque text. It is parsed into a
   * `DocumentId` at the point it is used to ask a question, so a descriptor restored from a
   * stale workspace opens an empty view rather than failing the whole restore.
   */
  documentId: z.string().min(1).nullable().default(null),
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
  /** A plain string for the reason `FocusPanelSchema` gives about its own. */
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
  FocusPanelSchema,
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
export type FocusPanel = z.infer<typeof FocusPanelSchema>;

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

export const SidebarStateSchema = z.object({
  library: z.boolean().default(true),
  /** The queue of research questions. Off by default; the library is what opens cold. */
  questions: z.boolean().default(false),
  /** The librarian: what it is allowed to send, and what it has proposed. */
  librarian: z.boolean().default(false),
  annotations: z.boolean().default(false),
  bottomPanel: z.boolean().default(false),
});
export type SidebarState = z.infer<typeof SidebarStateSchema>;

/**
 * What the sidebars are before anyone has touched them.
 *
 * Parsed out of the schema rather than written out again: the schema already declares each
 * default, and the two places that needed this literal — a fresh workspace and the renderer's
 * initial store — were a second and third copy of it that nothing would have caught diverging.
 */
export function defaultSidebars(): SidebarState {
  return SidebarStateSchema.parse({});
}

/**
 * The sidebars that share the single left slot, in the order the activity bar lists them.
 *
 * They shipped as independent booleans rendered as siblings, so opening all of them left
 * 252px of a 1440px window for the document — the reader, the thing the app is for, squeezed
 * to a column by its own chrome. An activity bar *switches* one slot; it does not stack.
 * `annotations` (right) and `bottomPanel` are genuinely independent and stay that way.
 *
 * The journal used to be here and is now a page in the workspace (`N09`): a day's thinking
 * needs a reader's width, not a filter's.
 */
export const LEFT_SIDEBARS = ['library', 'questions', 'librarian'] as const;
export type LeftSidebar = (typeof LEFT_SIDEBARS)[number];

function isLeftSidebar(which: keyof SidebarState): which is LeftSidebar {
  return (LEFT_SIDEBARS as readonly string[]).includes(which);
}

/**
 * Which left sidebar is showing, or `null` for none.
 *
 * Reads the first one set rather than trusting that only one is: a workspace persisted before
 * this rule existed can legitimately have several, and this is what collapses it.
 */
export function openLeftSidebar(state: SidebarState): LeftSidebar | null {
  return LEFT_SIDEBARS.find((name) => state[name]) ?? null;
}

/**
 * The left slot with exactly one occupant, or none.
 *
 * Written over `LEFT_SIDEBARS` rather than as an object literal per left sidebar, because the
 * literal was the list restated: adding a fourth meant editing two of them and finding out
 * from a stale layout which one had been missed.
 */
function withOpenSidebar(state: SidebarState, open: LeftSidebar | null): SidebarState {
  const next = { ...state };
  for (const name of LEFT_SIDEBARS) next[name] = name === open;
  return next;
}

/**
 * Apply the one-slot rule. Restoring a stale workspace goes through this too, so a layout
 * saved with all four open comes back with one rather than reproducing the defect on restart.
 */
export function normaliseSidebars(state: SidebarState): SidebarState {
  return withOpenSidebar(state, openLeftSidebar(state));
}

function sidebarsEqual(a: SidebarState, b: SidebarState): boolean {
  return LEFT_SIDEBARS.every((name) => a[name] === b[name]);
}

/**
 * Toggle one sidebar, keeping the left slot to a single occupant.
 *
 * Clicking the sidebar that is already showing closes it, which is what makes the activity
 * bar a toggle rather than a one-way switch. Clicking any other left sidebar replaces
 * whatever was there — the reader's width never depends on how many are open, because only
 * one can be.
 */
export function toggleSidebarState(
  state: SidebarState,
  which: keyof SidebarState,
): SidebarState {
  if (!isLeftSidebar(which)) return { ...state, [which]: !state[which] };
  return withOpenSidebar(state, openLeftSidebar(state) === which ? null : which);
}

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
  sidebars: SidebarStateSchema.default({
    library: true,
    questions: false,
    librarian: false,
    annotations: false,
    bottomPanel: false,
  }),
  history: NavigationHistoryStateSchema.default({ entries: [], cursor: -1 }),
});
export type SerializedWorkspace = z.infer<typeof SerializedWorkspaceSchema>;

export function emptyWorkspace(): SerializedWorkspace {
  return {
    version: WORKSPACE_LAYOUT_VERSION,
    dockview: null,
    panels: {},
    activePanelId: null,
    sidebars: defaultSidebars(),
    history: { entries: [], cursor: -1 },
  };
}

export interface WorkspaceSerializationInput {
  readonly dockview: unknown;
  readonly panels: Readonly<Record<string, PanelDescriptor>>;
  readonly activePanelId?: string | null;
  readonly sidebars?: Partial<SidebarState>;
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
    sidebars: {
      library: input.sidebars?.library ?? true,
      questions: input.sidebars?.questions ?? false,
      librarian: input.sidebars?.librarian ?? false,
      annotations: input.sidebars?.annotations ?? false,
      bottomPanel: input.sidebars?.bottomPanel ?? false,
    },
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

  // A workspace saved before the left slot held one sidebar can name several. Collapsing it
  // here rather than in the renderer means a restart cannot restore the stacked layout, and
  // no consumer of a deserialized workspace has to know the rule.
  const parsed = envelope.data;
  const sidebars = normaliseSidebars(parsed.sidebars);
  if (openLeftSidebar(parsed.sidebars) !== null && !sidebarsEqual(parsed.sidebars, sidebars)) {
    warnings.push('collapsed several open left sidebars to one');
  }
  const workspace = { ...parsed, sidebars };

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
      sidebars: workspace.sidebars,
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
