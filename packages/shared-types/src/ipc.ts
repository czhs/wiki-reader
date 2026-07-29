import { z } from 'zod';
import {
  AgentProposalIdSchema,
  AgentRunIdSchema,
  AnnotationIdSchema,
  CollectionIdSchema,
  DocumentFileIdSchema,
  DocumentIdSchema,
  HypothesisIdSchema,
  LinkIdSchema,
  NoteIdSchema,
  QuestionIdSchema,
} from './ids.js';
import {
  AnnotationAnchorSchema,
  DocumentLocationSchema,
  LinkableEntityTypeSchema,
} from './location.js';
import { HighlightColorSchema } from './highlight-colors.js';
import {
  AgentDisclosureSchema,
  CardArtDisclosureSchema,
  CardArtStatusSchema,
  AgentProposalSchema,
  AgentStatusSchema,
  AnnotationKindSchema,
  AnnotationSchema,
  AnnotationWithAnchorSchema,
  BoardCardSchema,
  CollectionSchema,
  LibrarianCapabilitySchema,
  ProposalStatusSchema,
  DocumentFileRefSchema,
  DocumentSchema,
  EvidenceStanceSchema,
  GraphNeighbourhoodSchema,
  GraphViewSettingsSchema,
  GraphViewportSchema,
  HypothesisSchema,
  HypothesisStatusSchema,
  JournalDateSchema,
  JournalEntrySchema,
  LibraryItemSchema,
  LinkOriginSchema,
  LinkSchema,
  NotebookPageSchema,
  NoteSchema,
  QuestionSchema,
  QuestionStatusSchema,
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
  /**
   * The collections available to pick from.
   *
   * Live from Zotero when it is running. When it is not, the collections mirrored by the last
   * import are listed instead and `live` is false — a picker that is empty whenever Zotero is
   * closed cannot show what the current scope even is, which is the thing it exists to show.
   */
  'zotero:listCollections': {
    request: empty,
    response: z.object({
      collections: z.array(
        z.object({
          /** The name an import is scoped by. */
          name: z.string(),
          /** The name with its ancestors, for a picker that can show the tree. */
          label: z.string(),
          /** Two collections may share a name; scoping by one then has to be refused. */
          ambiguous: z.boolean(),
        }),
      ),
      live: z.boolean(),
      message: z.string(),
    }),
  },
  /** The remembered pick list. Empty means the whole library. */
  'zotero:getImportScope': {
    request: empty,
    response: z.object({ collections: z.array(z.string()) }),
  },
  'zotero:setImportScope': {
    request: z.object({ collections: z.array(z.string().min(1)).max(200) }),
    response: z.object({ collections: z.array(z.string()) }),
  },
  'zotero:import': {
    request: z.object({
      /** Re-read every item even when the version is unchanged. */
      force: z.boolean().default(false),
      /**
       * Import only this collection and its subcollections. Absent means the whole library.
       * Scoping is additive: a later import of another collection adds to what is here.
       */
      collection: z.string().min(1).optional(),
      /**
       * Import these collections and their subcollections. Absent — not empty — falls back to
       * the remembered pick list, which is what makes the picks stick without every caller
       * having to read them first.
       */
      collections: z.array(z.string().min(1)).max(200).optional(),
    }),
    response: z.object({
      itemsSeen: z.number().int().nonnegative(),
      documentsCreated: z.number().int().nonnegative(),
      documentsUpdated: z.number().int().nonnegative(),
      documentsUnchanged: z.number().int().nonnegative(),
      /** Items a whole-library run passed over because they were removed on purpose. */
      documentsRemoved: z.number().int().nonnegative(),
      /** Removed documents this run brought back, because it named their collection. */
      documentsRestored: z.number().int().nonnegative(),
      filesLinked: z.number().int().nonnegative(),
      filesMissing: z.number().int().nonnegative(),
      collectionsImported: z.number().int().nonnegative(),
      tagsImported: z.number().int().nonnegative(),
      extractionJobsQueued: z.number().int().nonnegative(),
      durationMs: z.number().nonnegative(),
      warnings: z.array(z.string()),
      /** What the import covered: a collection name, or null for the whole library. */
      collectionScope: z.string().nullable(),
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
  /**
   * Which folder the notes come from.
   *
   * The response carries the folder's *name*, never its path: the renderer must not be able
   * to learn or reconstruct a filesystem path, which is the same rule that puts document
   * bytes behind `rrfile://`.
   */
  'corpus:folder': {
    request: empty,
    response: z.object({
      folderName: z.string(),
      /** True once the folder was chosen in the app rather than inherited from configuration. */
      chosenInApp: z.boolean(),
      noteCount: z.number().int().nonnegative(),
    }),
  },
  /**
   * Open the directory dialog, and adopt what comes back.
   *
   * No request payload, deliberately: the renderer asks for the choice to be *made*, and the
   * main process owns both the dialog and the answer. A channel that accepted a path would
   * hand a compromised renderer an arbitrary-directory read.
   */
  'corpus:chooseFolder': {
    request: empty,
    response: z.object({
      /** False when the dialog was cancelled, or the folder was unusable. */
      changed: z.boolean(),
      folderName: z.string(),
      chosenInApp: z.boolean(),
      noteCount: z.number().int().nonnegative(),
      /** Documents dropped because they came from a folder no longer in use. */
      purged: z.number().int().nonnegative(),
      filesSeen: z.number().int().nonnegative(),
      documentsCreated: z.number().int().nonnegative(),
      documentsUpdated: z.number().int().nonnegative(),
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
      /**
       * Where the document came from: `'zotero'` for imported items, `'corpus'` for the
       * markdown wiki. The library sidebar and the notes section are the same query with
       * different values, which is why this is a filter rather than two channels.
       */
      source: z.string().min(1).max(64).optional(),
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
  /**
   * Take a document out of the library (criteria B01, B03).
   *
   * A removal here is *local*: nothing is written to Zotero, and nothing is deleted. The
   * document is hidden and the annotations and links made on it stay exactly where they are —
   * which is why the response says how many of each survived rather than merely `{ ok: true }`.
   *
   * There is no channel for the other direction, on purpose. A removal means "not now", and
   * the way back is the shelf it came from: import the collection holding it and it returns,
   * with its highlights (criterion B01). A restore channel would need a list of removed things
   * to reach it from, and that list is a blacklist for the researcher to maintain.
   */
  'library:removeDocument': {
    request: z.object({ documentId: DocumentIdSchema }),
    response: z.object({
      removed: z.boolean(),
      annotationsKept: z.number().int().nonnegative(),
      linksKept: z.number().int().nonnegative(),
    }),
  },
  /**
   * Add files from the disk, without Zotero (criterion B02).
   *
   * No request payload, exactly as `corpus:chooseFolder` has none and for the same reason:
   * the renderer asks for the choice to be *made*, and the main process owns both the dialog
   * and the paths that come back. A channel that accepted a path would let a compromised
   * renderer name any file on the machine, have it added to the library, and then read it
   * back over `rrfile://` — an arbitrary-file-read wearing a feature's clothes.
   */
  'library:addFiles': {
    request: empty,
    response: z.object({
      /** False when the dialog was cancelled, or could not be opened at all. */
      chose: z.boolean(),
      added: z.number().int().nonnegative(),
      documentIds: z.array(DocumentIdSchema),
      /** Files picked that could not be added — unreadable, or not files. */
      failed: z.number().int().nonnegative(),
    }),
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
      color: HighlightColorSchema,
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
      color: HighlightColorSchema.optional(),
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

  // --- Questions: the queue -----------------------------------------------
  'question:create': {
    request: z.object({
      title: z.string().min(1),
      status: QuestionStatusSchema.optional(),
      importance: z.number().int().nullish(),
      nextAction: z.string().nullish(),
    }),
    response: z.object({ question: QuestionSchema }),
  },
  'question:get': {
    request: z.object({ questionId: QuestionIdSchema }),
    response: z.object({ question: QuestionSchema }),
  },
  /** In the hand-arranged order, always. Filtering never re-sorts. */
  'question:list': {
    request: z.object({ status: z.array(QuestionStatusSchema).optional() }),
    response: z.object({ questions: z.array(QuestionSchema) }),
  },
  'question:update': {
    request: z.object({
      questionId: QuestionIdSchema,
      title: z.string().min(1).optional(),
      status: QuestionStatusSchema.optional(),
      importance: z.number().int().nullish(),
      nextAction: z.string().nullish(),
      /** The page's front matter. Omitted means unchanged; null clears. */
      description: z.string().nullish(),
      tags: z.array(z.string().min(1)).optional(),
      coverFileId: DocumentFileIdSchema.nullish(),
    }),
    response: z.object({ question: QuestionSchema }),
  },
  /**
   * Discarding is its own channel because the reason is not optional. An `update` that
   * could set `status: 'discarded'` would make the reason forgettable, and the reason is
   * the part worth keeping.
   */
  'question:discard': {
    request: z.object({ questionId: QuestionIdSchema, reason: z.string().min(1) }),
    response: z.object({ question: QuestionSchema }),
  },
  /** The new order, in full, for the list that was dragged. */
  'question:reorder': {
    request: z.object({ questionIds: z.array(QuestionIdSchema).min(1) }),
    response: z.object({ questions: z.array(QuestionSchema) }),
  },
  /**
   * Attach a question to a paper or a highlight. An ordinary typed edge in `links` — the
   * channel exists only so both endpoints are checked to exist before the edge is written.
   */
  'question:attach': {
    request: z.object({
      questionId: QuestionIdSchema,
      targetType: z.enum(['document', 'annotation']),
      targetId: z.string().min(1),
      label: z.string().nullish(),
    }),
    response: z.object({ link: LinkSchema }),
  },

  // --- Field notebooks: the page behind a question -------------------------
  /**
   * Everything the page shows: front matter, prose and claims with their evidence. One
   * call, because a page with its hypotheses missing until a second round trip is a page
   * that flickers.
   */
  'question:notebook': {
    request: z.object({ questionId: QuestionIdSchema }),
    response: z.object({ page: NotebookPageSchema }),
  },
  /**
   * Write the prose. Markdown source, stored as typed — the front matter goes through
   * `question:update`, because it is the same row the queue reads.
   */
  'question:writeNotebook': {
    request: z.object({ questionId: QuestionIdSchema, body: z.string() }),
    response: z.object({ page: NotebookPageSchema }),
  },
  /**
   * Record where a card was dropped on a question's board.
   *
   * Sent at the *end* of a drag and at no other time. There is deliberately no "the board
   * rendered, here is where everything landed" call: a position that was never chosen by hand
   * is not a position, and storing one would freeze whatever the first layout happened to do.
   */
  'question:placeCard': {
    request: z.object({
      questionId: QuestionIdSchema,
      linkId: LinkIdSchema,
      /** Board coordinates, not screen ones. Finite; the board decides what is in view. */
      x: z.number().finite(),
      y: z.number().finite(),
    }),
    response: z.object({ card: BoardCardSchema }),
  },
  'hypothesis:create': {
    request: z.object({
      questionId: QuestionIdSchema,
      statement: z.string().min(1),
      status: HypothesisStatusSchema.optional(),
    }),
    response: z.object({ hypothesis: HypothesisSchema }),
  },
  'hypothesis:update': {
    request: z.object({
      hypothesisId: HypothesisIdSchema,
      statement: z.string().min(1).optional(),
      status: HypothesisStatusSchema.optional(),
    }),
    response: z.object({ hypothesis: HypothesisSchema }),
  },
  /**
   * Cite a paper or a highlight for or against a claim. An ordinary typed edge in `links`;
   * the channel exists so both endpoints are checked before the edge is written, which is
   * what keeps a citation from being evidence-shaped text.
   */
  'hypothesis:attachEvidence': {
    request: z.object({
      hypothesisId: HypothesisIdSchema,
      stance: EvidenceStanceSchema,
      sourceType: z.enum(['document', 'annotation']),
      sourceId: z.string().min(1),
      label: z.string().nullish(),
    }),
    response: z.object({ link: LinkSchema }),
  },

  // --- The journal --------------------------------------------------------
  'journal:get': {
    request: z.object({ date: JournalDateSchema }),
    /** Null for a day with no entry — which is every day nobody wrote on. */
    response: z.object({ entry: JournalEntrySchema.nullable() }),
  },
  /**
   * Write a day. Blank markdown deletes it and answers `null`: "no entry" and "an empty
   * entry" are the same fact, so there is no way through this channel to store the second.
   */
  'journal:write': {
    request: z.object({ date: JournalDateSchema, markdown: z.string() }),
    response: z.object({ entry: JournalEntrySchema.nullable() }),
  },
  /** The days that have an entry, for the calendar. Dates only, never a year of markdown. */
  'journal:loggedDates': {
    request: z.object({ from: JournalDateSchema.optional(), to: JournalDateSchema.optional() }),
    response: z.object({
      dates: z.array(JournalDateSchema),
      /**
       * The day the project began, which is where the calendar starts (`N10`) — the day this
       * library was made, or an older entry if the journal carries one.
       */
      projectStart: JournalDateSchema,
    }),
  },
  /** Say that a day's entry moved a question forward. An ordinary typed edge in `links`. */
  'journal:advancesQuestion': {
    request: z.object({ date: JournalDateSchema, questionId: QuestionIdSchema }),
    response: z.object({ link: LinkSchema }),
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

  // --- Graph --------------------------------------------------------------
  /**
   * The bounded neighbourhood around one entity.
   *
   * There is deliberately no "give me the graph" channel. The traversal runs in the main
   * process against SQLite, and what crosses the boundary is a seed plus a radius plus a node
   * cap — so the renderer's view is bounded by construction rather than by a renderer that
   * remembers to stop asking. `depth` and `nodeLimit` are capped here, in the contract, so a
   * renderer cannot widen them.
   */
  'graph:neighbourhood': {
    request: z.object({
      seedType: LinkableEntityTypeSchema,
      seedId: z.string().min(1),
      depth: z.number().int().positive().max(3).default(1),
      nodeLimit: z.number().int().positive().max(300).default(60),
    }),
    response: GraphNeighbourhoodSchema,
  },
  /**
   * How the graph is drawn, and where the graph on this seed was left.
   *
   * One round trip, because a panel that mounts needs both before it can draw once: asking
   * separately would draw the default view and then jump.
   */
  'graph:getView': {
    request: z.object({
      seedType: LinkableEntityTypeSchema.nullable().default(null),
      seedId: z.string().min(1).nullable().default(null),
    }),
    response: z.object({
      settings: GraphViewSettingsSchema,
      viewport: GraphViewportSchema.nullable(),
    }),
  },
  /** Change how every graph is drawn. Application-wide, so no seed. */
  'graph:setViewSettings': {
    request: GraphViewSettingsSchema,
    response: z.object({ settings: GraphViewSettingsSchema }),
  },
  /**
   * Rename a node, in the graph only.
   *
   * There is deliberately no `documentId` form and no path through `document:update`: the
   * name belongs to the node, and a channel that took a document would invite writing it into
   * the title the next import overwrites (`G03`). `null` removes the name.
   */
  'graph:setNodeName': {
    request: z.object({
      entityType: LinkableEntityTypeSchema,
      entityId: z.string().min(1),
      displayName: z.string().min(1).max(120).nullable(),
    }),
    response: z.object({ displayName: z.string().nullable() }),
  },
  /**
   * The images a node could be illustrated with: what the library already holds.
   *
   * The picker is fed from here rather than by filtering a page of `library:listDocuments`,
   * because an image added before two hundred papers is not on that page and would simply
   * never be offered. Titles and file ids only — the renderer is choosing between pictures it
   * can already draw, not being handed anything new.
   */
  'graph:iconChoices': {
    request: z.object({ limit: z.number().int().positive().max(200).default(50) }),
    response: z.object({
      choices: z.array(z.object({ fileId: DocumentFileIdSchema, title: z.string() })),
    }),
  },
  /**
   * Illustrate a node with an image the library already holds (criterion G04).
   *
   * A **file id**, not a path and not a URL: the renderer picks from what the library can
   * already show it, and the main process is the only side that knows where those bytes are.
   * A channel that took a path would be an arbitrary-file-read — the file would be admitted to
   * the allow-list and then readable over `rrfile://` — which is why adding a local image is a
   * drop and never an invoke. `null` takes the picture away.
   */
  'graph:setNodeIcon': {
    request: z.object({
      entityType: LinkableEntityTypeSchema,
      entityId: z.string().min(1),
      fileId: DocumentFileIdSchema.nullable(),
    }),
    response: z.object({ iconFileId: DocumentFileIdSchema.nullable() }),
  },
  /** Remember where the graph on this seed was left. */
  'graph:setViewport': {
    request: z.object({
      seedType: LinkableEntityTypeSchema,
      seedId: z.string().min(1),
      viewport: GraphViewportSchema,
    }),
    response: z.object({ viewport: GraphViewportSchema }),
  },

  // --- Card art -----------------------------------------------------------
  // The second exception to local-first (criterion G05), and the only channels in this file
  // behind which a request can leave the machine at all. Off by default; the disclosure comes
  // before the switch, and the switch before any fetch.
  'cardArt:status': {
    request: empty,
    response: CardArtStatusSchema,
  },
  /**
   * What a fetch would send, and where.
   *
   * Separate from the status for the reason `agent:disclosure` is: status is *whether*, and
   * disclosure is *what*. A panel that could render the switch without ever asking this
   * question would be a panel that can turn the exception on without showing it.
   */
  'cardArt:disclosure': {
    request: empty,
    response: CardArtDisclosureSchema,
  },
  /**
   * Turn card art on or off.
   *
   * Turning it on without `acknowledgeDisclosure` is refused until the disclosure has been
   * accepted once. The order lives here rather than in a component, because a rule a component
   * enforces is one re-arrangement away from being untrue.
   */
  'cardArt:enable': {
    request: z.object({
      enabled: z.boolean(),
      acknowledgeDisclosure: z.boolean().default(false),
    }),
    response: CardArtStatusSchema,
  },
  /**
   * Illustrate a node with the art for a named card.
   *
   * A **name**, never a URL. The host is built in the main process from one constant, so this
   * channel cannot be talked into asking a server of the caller's choosing for anything — the
   * request-forgery shape that an otherwise identical `{ url }` channel would have. What comes
   * back is a file id, like every other picture, and the bytes follow over `rrfile://`.
   */
  'cardArt:fetch': {
    request: z.object({
      entityType: LinkableEntityTypeSchema,
      entityId: z.string().min(1),
      name: z.string().min(1).max(200),
    }),
    response: z.object({
      iconFileId: DocumentFileIdSchema,
      /** False when this request left the machine. The second one for the same art is true. */
      fromCache: z.boolean(),
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

  // --- The librarian ------------------------------------------------------
  /**
   * Whether agents may run, what they may do, and what the last pass produced.
   *
   * Answered whether or not agents are enabled, and answering it starts nothing: this is the
   * channel the interface polls, and a status request that materialised the wiki would make
   * "off" untrue the moment the panel was opened.
   */
  'agent:status': {
    request: empty,
    response: AgentStatusSchema,
  },
  /**
   * What a run would send, and where it would go.
   *
   * Separate from `agent:status` because it is a different question — status is *whether*,
   * disclosure is *what* — and because computing it counts rows the status does not need.
   */
  'agent:disclosure': {
    request: empty,
    response: AgentDisclosureSchema,
  },
  /**
   * Turn agents on or off.
   *
   * Turning them on without `acknowledgeDisclosure` is refused when the disclosure has never
   * been accepted. The order lives here rather than in the panel, because a rule enforced by
   * a component is one re-arrangement away from being untrue (`A03`).
   */
  'agent:enable': {
    request: z.object({
      enabled: z.boolean(),
      acknowledgeDisclosure: z.boolean().default(false),
    }),
    response: AgentStatusSchema,
  },
  /**
   * Which capabilities are on.
   *
   * A capability that is off is removed from the prompt *and* refused at the proposal
   * boundary, so switching one off cannot be undone by a run that ignores the prompt (`A09`).
   */
  'agent:setCapabilities': {
    request: z.object({ capabilities: z.array(LibrarianCapabilitySchema).max(16) }),
    response: AgentStatusSchema,
  },
  /** Run a pass now. Refused while agents are off, or while one is already running. */
  'agent:run': {
    request: empty,
    response: z.object({
      runId: AgentRunIdSchema,
      status: z.enum(['running', 'finished', 'failed', 'cancelled']),
      proposals: z.number().int().nonnegative(),
      /** Proposals the boundary refused. Reported so a run of nothing but rejects is visible. */
      rejected: z.number().int().nonnegative(),
    }),
  },
  'agent:cancel': {
    request: z.object({ runId: AgentRunIdSchema }),
    response: z.object({ cancelled: z.boolean() }),
  },
  /** What the librarian has proposed. Pending by default: those are the ones awaiting a person. */
  'agent:listProposals': {
    request: z.object({
      status: ProposalStatusSchema.optional(),
      limit: z.number().int().positive().max(500).default(100),
    }),
    response: z.object({ proposals: z.array(AgentProposalSchema) }),
  },
  /** Accept: write it into the workspace, and make it a document in the wiki. */
  'agent:accept': {
    request: z.object({ proposalId: AgentProposalIdSchema }),
    response: z.object({ proposal: AgentProposalSchema }),
  },
  /** Reject: writes nothing. The decision is the whole of the effect. */
  'agent:reject': {
    request: z.object({ proposalId: AgentProposalIdSchema }),
    response: z.object({ proposal: AgentProposalSchema }),
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
  /**
   * A question's board changed on the main process's side.
   *
   * The one thing that does this today is a file dropped on the board: the drop is handled in
   * the preload — the only place that can turn a `File` into a path — so the renderer cannot
   * learn the outcome from its own call. It learns it here, the same way it would learn about
   * a card added in another window.
   */
  'notebook:changed': z.object({
    questionId: QuestionIdSchema,
    reason: z.enum(['drop']),
    /** How many cards the change added. Zero when every dropped file was refused. */
    added: z.number().int().nonnegative(),
  }),
  'zotero:importProgress': z.object({
    phase: z.enum(['collections', 'items', 'attachments', 'done']),
    processed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  /**
   * A pass, while it is happening.
   *
   * A librarian run takes minutes, and `--output-format stream-json` exists so it is watchable
   * rather than a black box that answers later. This is that stream, reduced to what an
   * interface can show: what it is doing now, and whether it is still doing it.
   */
  'agent:progress': z.object({
    runId: AgentRunIdSchema,
    phase: z.enum(['started', 'working', 'finished']),
    /** The current step in one short line, e.g. `Read documents/doc_….md`. */
    detail: z.string(),
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
