import { z } from 'zod';
import {
  AnnotationIdSchema,
  CollectionIdSchema,
  DocumentFileIdSchema,
  DocumentIdSchema,
  LinkIdSchema,
  NoteIdSchema,
} from './ids.js';
import {
  AnnotationAnchorSchema,
  DocumentLocationSchema,
  LinkableEntityTypeSchema,
} from './location.js';
import {
  AnnotationKindSchema,
  AnnotationSchema,
  AnnotationWithAnchorSchema,
  CollectionSchema,
  DocumentFileRefSchema,
  DocumentSchema,
  LibraryItemSchema,
  LinkOriginSchema,
  LinkSchema,
  NoteSchema,
  ReadingPositionSchema,
  ResolvedLinkSchema,
  SearchFiltersSchema,
  SearchResultSchema,
  TagSchema,
  WorkspaceLayoutSchema,
} from './domain.js';

/**
 * The complete IPC surface. Every channel declares a request and response schema.
 *
 * The preload exposes exactly one `invoke` and one `subscribe`. There is no other path
 * from the renderer to the main process — no filesystem, no database handle, no shell,
 * no raw ipcRenderer.
 *
 * The main process validates the request against `request` *before* dispatching, and
 * validates its own value against `response` in development.
 */

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export const IpcErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'NOT_FOUND',
  'CONFLICT',
  'ZOTERO_UNREACHABLE',
  'ZOTERO_API_DISABLED',
  'ZOTERO_HTTP_ERROR',
  'FILE_MISSING',
  'FILE_FORBIDDEN',
  'EXTRACTION_FAILED',
  'DATABASE_ERROR',
  'UNSUPPORTED',
  'INTERNAL',
]);
export type IpcErrorCode = z.infer<typeof IpcErrorCodeSchema>;

export const IpcErrorSchema = z.object({
  code: IpcErrorCodeSchema,
  message: z.string(),
  /** Safe, structured context. Never a stack trace. */
  details: z.record(z.unknown()).optional(),
  /** Concrete action the user can take, when one exists. */
  remedy: z.string().optional(),
});
export type IpcError = z.infer<typeof IpcErrorSchema>;

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

export const ipcOk = <T>(value: T): IpcResult<T> => ({ ok: true, value });
export const ipcErr = (error: IpcError): IpcResult<never> => ({ ok: false, error });

// ---------------------------------------------------------------------------
// Channel definitions
// ---------------------------------------------------------------------------

const empty = z.object({});

export const IPC_CHANNELS = {
  // --- Zotero -------------------------------------------------------------
  'zotero:probe': {
    request: empty,
    response: z.object({
      running: z.boolean(),
      localApiEnabled: z.boolean(),
      /** Zotero's reported library version, when reachable. */
      libraryVersion: z.number().int().nonnegative().nullable(),
      endpoint: z.string(),
      message: z.string(),
      remedy: z.string().nullable(),
    }),
  },
  'zotero:import': {
    request: z.object({
      /** Re-read every item even when the version is unchanged. */
      force: z.boolean().default(false),
    }),
    response: z.object({
      itemsSeen: z.number().int().nonnegative(),
      documentsCreated: z.number().int().nonnegative(),
      documentsUpdated: z.number().int().nonnegative(),
      documentsUnchanged: z.number().int().nonnegative(),
      filesLinked: z.number().int().nonnegative(),
      filesMissing: z.number().int().nonnegative(),
      collectionsImported: z.number().int().nonnegative(),
      tagsImported: z.number().int().nonnegative(),
      extractionJobsQueued: z.number().int().nonnegative(),
      durationMs: z.number().nonnegative(),
      warnings: z.array(z.string()),
    }),
  },

  // --- Markdown corpus ----------------------------------------------------
  /**
   * Import the configured markdown corpus.
   *
   * There is deliberately no folder argument: the root lives in main-process configuration,
   * so a renderer cannot name a directory to read.
   */
  'corpus:import': {
    request: z.object({
      /** Re-parse and re-index every file even when its bytes are unchanged. */
      force: z.boolean().default(false),
    }),
    response: z.object({
      filesSeen: z.number().int().nonnegative(),
      documentsCreated: z.number().int().nonnegative(),
      documentsUpdated: z.number().int().nonnegative(),
      documentsUnchanged: z.number().int().nonnegative(),
      linksCreated: z.number().int().nonnegative(),
      wantedPages: z.number().int().nonnegative(),
      durationMs: z.number().nonnegative(),
      warnings: z.array(z.string()),
    }),
  },
  /** Pages the corpus links to but does not contain yet. */
  'corpus:wantedPages': {
    request: z.object({ limit: z.number().int().positive().max(1000).default(200) }),
    response: z.object({
      pages: z.array(
        z.object({
          slug: z.string(),
          title: z.string(),
          count: z.number().int().nonnegative(),
          referencedBy: z.array(DocumentIdSchema),
        }),
      ),
    }),
  },

  // --- Library ------------------------------------------------------------
  'library:listDocuments': {
    request: z.object({
      collectionId: CollectionIdSchema.optional(),
      tag: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().int().positive().max(1000).default(200),
      offset: z.number().int().nonnegative().default(0),
    }),
    response: z.object({
      items: z.array(LibraryItemSchema),
      total: z.number().int().nonnegative(),
    }),
  },
  'library:getDocument': {
    request: z.object({ documentId: DocumentIdSchema }),
    response: z.object({ item: LibraryItemSchema }),
  },
  'library:listCollections': {
    request: empty,
    response: z.object({ collections: z.array(CollectionSchema) }),
  },
  'library:listTags': {
    request: empty,
    response: z.object({ tags: z.array(TagSchema) }),
  },

  // --- Documents ----------------------------------------------------------
  'document:openFile': {
    request: z.object({ fileId: DocumentFileIdSchema }),
    response: z.object({
      file: DocumentFileRefSchema,
      document: DocumentSchema,
    }),
  },
  'document:getReadingPosition': {
    request: z.object({ documentId: DocumentIdSchema }),
    response: z.object({ position: ReadingPositionSchema.nullable() }),
  },
  'document:setReadingPosition': {
    request: z.object({
      documentId: DocumentIdSchema,
      location: DocumentLocationSchema,
    }),
    response: z.object({ position: ReadingPositionSchema }),
  },
  'document:getOutline': {
    request: z.object({ documentId: DocumentIdSchema }),
    response: z.object({
      outline: z.array(
        z.object({
          title: z.string(),
          level: z.number().int().positive(),
          location: DocumentLocationSchema,
        }),
      ),
    }),
  },
  'document:requestExtraction': {
    request: z.object({ documentId: DocumentIdSchema }),
    response: z.object({ queued: z.boolean() }),
  },

  // --- Annotations --------------------------------------------------------
  'annotation:create': {
    request: z.object({
      documentId: DocumentIdSchema,
      kind: AnnotationKindSchema,
      color: z.string(),
      selectedText: z.string().min(1),
      comment: z.string().nullable().default(null),
      anchor: AnnotationAnchorSchema,
    }),
    response: z.object({ annotation: AnnotationWithAnchorSchema }),
  },
  'annotation:listByDocument': {
    request: z.object({ documentId: DocumentIdSchema }),
    response: z.object({ annotations: z.array(AnnotationWithAnchorSchema) }),
  },
  'annotation:get': {
    request: z.object({ annotationId: AnnotationIdSchema }),
    response: z.object({ annotation: AnnotationWithAnchorSchema }),
  },
  'annotation:update': {
    request: z.object({
      annotationId: AnnotationIdSchema,
      color: z.string().optional(),
      comment: z.string().nullable().optional(),
    }),
    response: z.object({ annotation: AnnotationSchema }),
  },
  'annotation:delete': {
    request: z.object({ annotationId: AnnotationIdSchema }),
    response: z.object({ deleted: z.boolean() }),
  },

  // --- Notes --------------------------------------------------------------
  'note:create': {
    request: z.object({
      title: z.string(),
      contentJson: z.unknown(),
      contentText: z.string(),
      /** When present, links the new note to this annotation. */
      attachToAnnotationId: AnnotationIdSchema.optional(),
      attachToDocumentId: DocumentIdSchema.optional(),
    }),
    response: z.object({ note: NoteSchema, links: z.array(LinkSchema) }),
  },
  'note:get': {
    request: z.object({ noteId: NoteIdSchema }),
    response: z.object({ note: NoteSchema }),
  },
  'note:update': {
    request: z.object({
      noteId: NoteIdSchema,
      title: z.string().optional(),
      contentJson: z.unknown().optional(),
      contentText: z.string().optional(),
    }),
    response: z.object({ note: NoteSchema }),
  },
  'note:list': {
    request: z.object({
      limit: z.number().int().positive().max(1000).default(200),
      offset: z.number().int().nonnegative().default(0),
    }),
    response: z.object({ notes: z.array(NoteSchema), total: z.number().int() }),
  },
  'note:listForAnnotation': {
    request: z.object({ annotationId: AnnotationIdSchema }),
    response: z.object({ notes: z.array(NoteSchema) }),
  },

  // --- Links --------------------------------------------------------------
  'link:create': {
    request: z.object({
      type: z.string().min(1),
      sourceType: LinkableEntityTypeSchema,
      sourceId: z.string().min(1),
      targetType: LinkableEntityTypeSchema,
      targetId: z.string().min(1),
      sourceLocation: DocumentLocationSchema.nullish(),
      targetLocation: DocumentLocationSchema.nullish(),
      label: z.string().nullish(),
      ordinal: z.number().int().nullish(),
      origin: LinkOriginSchema.default('manual'),
      generator: z.string().nullish(),
      metadata: z.record(z.unknown()).nullish(),
    }),
    response: z.object({ link: LinkSchema }),
  },
  'link:delete': {
    request: z.object({ linkId: LinkIdSchema }),
    response: z.object({ deleted: z.boolean() }),
  },
  /** Every link touching the entity, in either direction. */
  'link:findReferences': {
    request: z.object({
      entityType: LinkableEntityTypeSchema,
      entityId: z.string().min(1),
      direction: z.enum(['incoming', 'outgoing', 'both']).default('both'),
      limit: z.number().int().positive().max(2000).default(500),
    }),
    response: z.object({ links: z.array(ResolvedLinkSchema) }),
  },
  /** Every link of one semantic type, with optional narrowing. */
  'link:findByType': {
    request: z.object({
      type: z.string().min(1),
      documentId: DocumentIdSchema.optional(),
      collectionId: CollectionIdSchema.optional(),
      sourceType: LinkableEntityTypeSchema.optional(),
      targetType: LinkableEntityTypeSchema.optional(),
      direction: z.enum(['incoming', 'outgoing', 'both']).default('both'),
      origin: LinkOriginSchema.optional(),
      generator: z.string().optional(),
      createdAfter: z.string().optional(),
      createdBefore: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().positive().max(2000).default(500),
    }),
    response: z.object({ links: z.array(ResolvedLinkSchema) }),
  },
  /** The immediate semantic parent of an entity, for goToParent. */
  'link:getParent': {
    request: z.object({
      entityType: LinkableEntityTypeSchema,
      entityId: z.string().min(1),
    }),
    response: z.object({
      parent: z
        .object({
          entityType: LinkableEntityTypeSchema,
          entityId: z.string(),
          title: z.string(),
          documentId: DocumentIdSchema.nullable(),
          location: DocumentLocationSchema.nullable(),
        })
        .nullable(),
    }),
  },
  /** Everything the peek widget needs, in one round trip. */
  'link:peek': {
    request: z.object({
      entityType: LinkableEntityTypeSchema,
      entityId: z.string().min(1),
    }),
    response: z.object({
      title: z.string(),
      entityType: LinkableEntityTypeSchema,
      documentTitle: z.string().nullable(),
      documentId: DocumentIdSchema.nullable(),
      excerpt: z.string(),
      locationLabel: z.string(),
      location: DocumentLocationSchema.nullable(),
      parentLabel: z.string().nullable(),
      incomingCount: z.number().int().nonnegative(),
      outgoingCount: z.number().int().nonnegative(),
      broken: z.boolean(),
    }),
  },

  // --- Search -------------------------------------------------------------
  'search:query': {
    request: z.object({
      query: z.string(),
      filters: SearchFiltersSchema.default({}),
      limit: z.number().int().positive().max(500).default(100),
      offset: z.number().int().nonnegative().default(0),
    }),
    response: z.object({
      results: z.array(SearchResultSchema),
      total: z.number().int().nonnegative(),
      /** The FTS5 expression actually executed, for debugging and the status bar. */
      normalizedQuery: z.string(),
      durationMs: z.number().nonnegative(),
    }),
  },
  'search:status': {
    request: empty,
    response: z.object({
      queued: z.number().int().nonnegative(),
      running: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      indexedDocuments: z.number().int().nonnegative(),
      totalDocuments: z.number().int().nonnegative(),
    }),
  },

  // --- Workspace ----------------------------------------------------------
  'workspace:loadLayout': {
    request: z.object({ name: z.string().default('default') }),
    response: z.object({ layout: WorkspaceLayoutSchema.nullable() }),
  },
  'workspace:saveLayout': {
    request: z.object({
      name: z.string().default('default'),
      layout: z.unknown(),
      panelState: z.record(z.unknown()).default({}),
    }),
    response: z.object({ saved: z.boolean() }),
  },
} as const;

export type IpcChannel = keyof typeof IPC_CHANNELS;

export type IpcRequest<K extends IpcChannel> = z.input<(typeof IPC_CHANNELS)[K]['request']>;
export type IpcRequestParsed<K extends IpcChannel> = z.output<
  (typeof IPC_CHANNELS)[K]['request']
>;
export type IpcResponse<K extends IpcChannel> = z.output<(typeof IPC_CHANNELS)[K]['response']>;

export const isIpcChannel = (value: string): value is IpcChannel =>
  Object.prototype.hasOwnProperty.call(IPC_CHANNELS, value);

// ---------------------------------------------------------------------------
// Main -> renderer events
// ---------------------------------------------------------------------------

export const IPC_TOPICS = {
  'indexing:progress': z.object({
    documentId: DocumentIdSchema,
    stage: z.enum(['extract', 'chunk', 'index', 'done', 'error']),
    processed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    message: z.string().optional(),
  }),
  'library:changed': z.object({
    reason: z.enum(['import', 'annotation', 'note', 'delete']),
    documentIds: z.array(DocumentIdSchema),
  }),
  'zotero:importProgress': z.object({
    phase: z.enum(['collections', 'items', 'attachments', 'done']),
    processed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
} as const;

export type IpcTopic = keyof typeof IPC_TOPICS;
export type IpcTopicPayload<K extends IpcTopic> = z.output<(typeof IPC_TOPICS)[K]>;

/**
 * The single object the preload places on `window`.
 *
 * Exactly two functions. Anything else the renderer needs about its environment it derives
 * from standard web APIs, so that auditing the bridge means reading two signatures.
 */
export interface RendererBridge {
  invoke<K extends IpcChannel>(
    channel: K,
    request: IpcRequest<K>,
  ): Promise<IpcResult<IpcResponse<K>>>;
  subscribe<K extends IpcTopic>(
    topic: K,
    handler: (payload: IpcTopicPayload<K>) => void,
  ): () => void;
}
