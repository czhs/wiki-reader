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
 * The seed and the depth are the panel's whole state because they are the whole query: the
 * main process answers with the neighbourhood they describe, and the panel holds no graph of
 * its own to restore. A restored panel re-asks and gets what is true now.
 */
export const LinkGraphPanelSchema = z.object({
  kind: z.literal('link-graph'),
  seedEntityId: z.string().min(1).nullable().default(null),
  seedEntityType: z.string().min(1).nullable().default(null),
  depth: z.number().int().positive().max(3).default(1),
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
]);
export type PanelDescriptor = z.infer<typeof PanelDescriptorSchema>;

export type PdfReaderPanel = z.infer<typeof PdfReaderPanelSchema>;
export type ArticleReaderPanel = z.infer<typeof ArticleReaderPanelSchema>;
export type MarkdownReaderPanel = z.infer<typeof MarkdownReaderPanelSchema>;
export type NoteEditorPanel = z.infer<typeof NoteEditorPanelSchema>;
export type ReferencesPanel = z.infer<typeof ReferencesPanelSchema>;

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
  /** The dated journal. */
  journal: z.boolean().default(false),
  /** The librarian: what it is allowed to send, and what it has proposed. */
  librarian: z.boolean().default(false),
  annotations: z.boolean().default(false),
  bottomPanel: z.boolean().default(false),
});
export type SidebarState = z.infer<typeof SidebarStateSchema>;

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
    journal: false,
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
    sidebars: {
      library: true,
      questions: false,
      journal: false,
      librarian: false,
      annotations: false,
      bottomPanel: false,
    },
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
      journal: input.sidebars?.journal ?? false,
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
