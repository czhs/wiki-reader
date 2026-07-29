import { z } from 'zod';
import {
  AgentProposalIdSchema,
  AgentRunIdSchema,
  AnnotationAnchorIdSchema,
  AnnotationIdSchema,
  CollectionIdSchema,
  DocumentChunkIdSchema,
  DocumentFileIdSchema,
  DocumentIdSchema,
  DocumentRevisionIdSchema,
  ExternalReferenceIdSchema,
  HypothesisIdSchema,
  IndexingJobIdSchema,
  LinkIdSchema,
  NoteIdSchema,
  QuestionIdSchema,
  TagIdSchema,
} from './ids.js';
import {
  AnnotationAnchorSchema,
  DocumentLocationSchema,
  LinkableEntityTypeSchema,
} from './location.js';
import { HighlightColorSchema } from './highlight-colors.js';

/** ISO-8601 UTC timestamp, e.g. 2026-07-25T09:12:33.001Z */
export const TimestampSchema = z.string().datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;

export const DocumentTypeSchema = z.enum(['pdf', 'webpage', 'markdown', 'note', 'other']);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const AuthorSchema = z.object({
  family: z.string(),
  given: z.string().optional(),
  literal: z.string().optional(),
});
export type Author = z.infer<typeof AuthorSchema>;

export const DocumentSchema = z.object({
  id: DocumentIdSchema,
  title: z.string(),
  docType: DocumentTypeSchema,
  authors: z.array(AuthorSchema),
  abstract: z.string().nullable(),
  /** Publication date as recorded upstream; may be partial (YYYY or YYYY-MM). */
  publishedDate: z.string().nullable(),
  /** Where the record came from, e.g. 'zotero' or 'manual'. */
  source: z.string(),
  /**
   * Wiki page name a `[[wikilink]]` resolves against. Only corpus documents have one — a
   * Zotero PDF is addressed by title and id, never by page name.
   */
  slug: z.string().nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable(),
});
export type Document = z.infer<typeof DocumentSchema>;

export const DocumentFileRoleSchema = z.enum([
  'primary',
  'supplementary',
  'snapshot',
  'original-snapshot',
]);
export type DocumentFileRole = z.infer<typeof DocumentFileRoleSchema>;

export const DocumentFileSchema = z.object({
  id: DocumentFileIdSchema,
  documentId: DocumentIdSchema,
  revisionId: DocumentRevisionIdSchema.nullable(),
  /** Absolute path on disk. Never sent to the renderer. */
  path: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  /** SHA-256 of the file bytes. */
  contentHash: z.string(),
  role: DocumentFileRoleSchema,
  createdAt: TimestampSchema,
});
export type DocumentFile = z.infer<typeof DocumentFileSchema>;

/** Renderer-safe projection of a file: no filesystem path. */
export const DocumentFileRefSchema = DocumentFileSchema.omit({ path: true }).extend({
  /** Custom-protocol URL the renderer may load: rrfile://<fileId> */
  url: z.string().startsWith('rrfile://'),
});
export type DocumentFileRef = z.infer<typeof DocumentFileRefSchema>;

export const DocumentRevisionSchema = z.object({
  id: DocumentRevisionIdSchema,
  documentId: DocumentIdSchema,
  revisionNo: z.number().int().positive(),
  contentHash: z.string(),
  extractedTextHash: z.string().nullable(),
  createdAt: TimestampSchema,
});
export type DocumentRevision = z.infer<typeof DocumentRevisionSchema>;

export const DocumentChunkSchema = z.object({
  id: DocumentChunkIdSchema,
  documentId: DocumentIdSchema,
  revisionId: DocumentRevisionIdSchema,
  chunkIndex: z.number().int().nonnegative(),
  kind: z.enum(['pdf-page', 'html-section', 'markdown-section', 'note-block']),
  pageIndex: z.number().int().nonnegative().nullable(),
  sectionPath: z.string().nullable(),
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().nonnegative(),
  text: z.string(),
});
export type DocumentChunk = z.infer<typeof DocumentChunkSchema>;

export const AnnotationKindSchema = z.enum(['highlight', 'underline', 'note-anchor']);
export type AnnotationKind = z.infer<typeof AnnotationKindSchema>;

export const AnnotationSchema = z.object({
  id: AnnotationIdSchema,
  documentId: DocumentIdSchema,
  revisionId: DocumentRevisionIdSchema.nullable(),
  kind: AnnotationKindSchema,
  /**
   * A palette name, never a hex value. Rows written before the palette existed are mapped
   * through `resolveHighlightColor` at the storage boundary, so this side is always one of
   * the six.
   */
  color: HighlightColorSchema,
  /**
   * The text as it existed when the annotation was created. Retained verbatim even when
   * an embedded excerpt re-resolves the annotation by ID.
   */
  selectedText: z.string(),
  comment: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

export const AnnotationWithAnchorSchema = AnnotationSchema.extend({
  anchorId: AnnotationAnchorIdSchema,
  anchor: AnnotationAnchorSchema,
});
export type AnnotationWithAnchor = z.infer<typeof AnnotationWithAnchorSchema>;

export const NoteSchema = z.object({
  id: NoteIdSchema,
  title: z.string(),
  /** Tiptap/ProseMirror JSON document. */
  contentJson: z.unknown(),
  /** Flattened plain text, kept in sync for FTS indexing. */
  contentText: z.string(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable(),
});
export type Note = z.infer<typeof NoteSchema>;

// ---------------------------------------------------------------------------
// Questions — the queue
// ---------------------------------------------------------------------------

/**
 * Which list a question appears in. `discarded` is not a delete: the question and the
 * reason it was dropped are the useful residue of having asked it.
 */
export const QuestionStatusSchema = z.enum(['active', 'queued', 'discarded']);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

export const QuestionSchema = z.object({
  id: QuestionIdSchema,
  title: z.string(),
  status: QuestionStatusSchema,
  /**
   * Position in the hand-arranged queue. Stored rather than derived, because the
   * arrangement *is* a judgement about what to do next — sorting by date or importance
   * would throw exactly that away.
   */
  ordinal: z.number().int().nonnegative(),
  /** Rough priority, as in the reference notebook. Nothing sorts by it. */
  importance: z.number().int().nullable(),
  /** The next concrete step, so the active list reads at a glance. */
  nextAction: z.string().nullable(),
  /** Why it was dropped. Required to discard, kept afterwards. */
  discardedReason: z.string().nullable(),
  /** When it first became active. */
  startedAt: TimestampSchema.nullable(),
  /** A sentence of context, so the active list reads at a glance. */
  description: z.string().nullable(),
  /** The page's tags, by name — the same rows the library already tags documents with. */
  tags: z.array(z.string()),
  /**
   * The page's cover image, as a file id. Never a path: the renderer loads it over
   * `rrfile://` like every other byte it is allowed to see.
   */
  coverFileId: DocumentFileIdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Question = z.infer<typeof QuestionSchema>;

/**
 * Where a claim stands. `open` is the honest default — a hypothesis nobody has weighed
 * evidence against yet is not "unsupported", it is unexamined.
 */
export const HypothesisStatusSchema = z.enum(['open', 'supported', 'refuted', 'abandoned']);
export type HypothesisStatus = z.infer<typeof HypothesisStatusSchema>;

export const HypothesisSchema = z.object({
  id: HypothesisIdSchema,
  questionId: QuestionIdSchema,
  statement: z.string(),
  status: HypothesisStatusSchema,
  /** Position on the page, in the order the researcher put them. */
  ordinal: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

/** Which way a piece of evidence cuts. */
export const EvidenceStanceSchema = z.enum(['supports', 'opposes']);
export type EvidenceStance = z.infer<typeof EvidenceStanceSchema>;

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

/** A calendar day, `YYYY-MM-DD`. The journal's identity, not a timestamp. */
export const JournalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'a journal date is an ISO calendar day, YYYY-MM-DD');
export type JournalDate = z.infer<typeof JournalDateSchema>;

/**
 * One day of the research diary.
 *
 * There is no entry for an unlogged day: blanking one deletes it. "No entry" and "an empty
 * entry" are the same fact, and a calendar that showed them differently would be lying.
 */
export const JournalEntrySchema = z.object({
  date: JournalDateSchema,
  /** Markdown source, as typed. */
  markdown: z.string().min(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** Known link types. Open-ended: arbitrary strings are permitted. */
export const KNOWN_LINK_TYPES = [
  'document-cites-document',
  'note-references-document',
  'note-references-note',
  'note-references-annotation',
  'annotation-references-annotation',
  'annotation-belongs-to-document',
  'excerpt-derived-from-annotation',
  // A question to the papers that bear on it and the highlights that evidence it. Same
  // table, same shape as every other relationship — there is no second mechanism.
  'question-references-document',
  'question-references-annotation',
  // Evidence for and against a claim. Directed from the evidence, because it is the paper
  // or the highlight that bears on the hypothesis, not the other way round.
  'document-supports-hypothesis',
  'document-opposes-hypothesis',
  'annotation-supports-hypothesis',
  'annotation-opposes-hypothesis',
  // A day's entry to the question it moved forward. Directed from the entry, because what
  // the researcher wrote is what claims the progress.
  'journal-entry-advances-question',
  'child-of',
  'related-to',
] as const;

export type KnownLinkType = (typeof KNOWN_LINK_TYPES)[number];
export const LinkTypeSchema = z.string().min(1);
export type LinkType = KnownLinkType | (string & {});

export const LinkOriginSchema = z.enum(['manual', 'derived']);
export type LinkOrigin = z.infer<typeof LinkOriginSchema>;

export const LinkSchema = z.object({
  id: LinkIdSchema,
  type: LinkTypeSchema,
  sourceId: z.string().min(1),
  sourceType: LinkableEntityTypeSchema,
  targetId: z.string().min(1),
  targetType: LinkableEntityTypeSchema,
  sourceLocation: DocumentLocationSchema.nullable(),
  targetLocation: DocumentLocationSchema.nullable(),
  label: z.string().nullable(),
  /** Ordering among siblings for parent-child relationships. */
  ordinal: z.number().int().nullable(),
  origin: LinkOriginSchema,
  /** Which importer or parser produced a derived link. */
  generator: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Link = z.infer<typeof LinkSchema>;

/** A link paired with resolved display information about the other endpoint. */
export const ResolvedLinkSchema = LinkSchema.extend({
  direction: z.enum(['incoming', 'outgoing']),
  /** The endpoint that is *not* the queried entity. */
  otherTitle: z.string(),
  otherType: LinkableEntityTypeSchema,
  otherDocumentId: DocumentIdSchema.nullable(),
  excerpt: z.string().nullable(),
  /** The other endpoint no longer resolves to a row. Surfaced as a broken-link warning. */
  broken: z.boolean(),
  /** Where to reveal the other endpoint, when it has a precise location. */
  otherLocation: DocumentLocationSchema.nullable(),
});
export type ResolvedLink = z.infer<typeof ResolvedLinkSchema>;

// ---------------------------------------------------------------------------
// Field notebooks
// ---------------------------------------------------------------------------

/**
 * A claim with the evidence weighed on both sides.
 *
 * The citations are *resolved* links, not ids: a page that could only name the id of a
 * highlight would be evidence-shaped rather than evidence, and a citation that no longer
 * resolves has to say so rather than quietly disappear.
 */
export const HypothesisWithEvidenceSchema = HypothesisSchema.extend({
  supporting: z.array(ResolvedLinkSchema),
  opposing: z.array(ResolvedLinkSchema),
});
export type HypothesisWithEvidence = z.infer<typeof HypothesisWithEvidenceSchema>;

/**
 * The page behind a question: its front matter, its prose and its claims.
 *
 * `body` is markdown *source*, as typed. Nothing renders it on the way in or out — prose
 * stored as anything but its source is prose only one editor can read.
 */
export const NotebookPageSchema = z.object({
  question: QuestionSchema,
  body: z.string(),
  hypotheses: z.array(HypothesisWithEvidenceSchema),
});
export type NotebookPage = z.infer<typeof NotebookPageSchema>;

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/**
 * One node of a *bounded* neighbourhood.
 *
 * `degree` counts the edges the entity has in the whole database, not the ones in this view:
 * that difference is what tells the reader "this node continues past the edge of what you are
 * looking at" instead of presenting a window as the whole picture.
 */
export const GraphNodeSchema = z.object({
  entityType: LinkableEntityTypeSchema,
  entityId: z.string().min(1),
  title: z.string(),
  /** The document to open when the node is activated; null for entities without one. */
  documentId: DocumentIdSchema.nullable(),
  /** Hops from the seed. The seed itself is 0. */
  distance: z.number().int().nonnegative(),
  degree: z.number().int().nonnegative(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: LinkIdSchema,
  type: LinkTypeSchema,
  sourceType: LinkableEntityTypeSchema,
  sourceId: z.string().min(1),
  targetType: LinkableEntityTypeSchema,
  targetId: z.string().min(1),
  origin: LinkOriginSchema,
  label: z.string().nullable(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphNeighbourhoodSchema = z.object({
  seed: z.object({
    entityType: LinkableEntityTypeSchema,
    entityId: z.string().min(1),
    title: z.string(),
  }),
  depth: z.number().int().positive(),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  /** Nodes inside the depth bound that the node cap dropped. */
  elidedNodes: z.number().int().nonnegative(),
  /** True when anything was dropped: a truncation is reported, never silent. */
  truncated: z.boolean(),
});
export type GraphNeighbourhood = z.infer<typeof GraphNeighbourhoodSchema>;

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------

export const CollectionSchema = z.object({
  id: CollectionIdSchema,
  name: z.string(),
  parentId: CollectionIdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Collection = z.infer<typeof CollectionSchema>;

export const TagSchema = z.object({
  id: TagIdSchema,
  name: z.string(),
});
export type Tag = z.infer<typeof TagSchema>;

export const ReadingPositionSchema = z.object({
  documentId: DocumentIdSchema,
  location: DocumentLocationSchema,
  updatedAt: TimestampSchema,
});
export type ReadingPosition = z.infer<typeof ReadingPositionSchema>;

export const WorkspaceLayoutSchema = z.object({
  name: z.string(),
  /** Serialized Dockview layout. Opaque to the main process. */
  layout: z.unknown(),
  /** Per-panel state keyed by panel id (open document, scroll, query, ...). */
  panelState: z.record(z.unknown()),
  updatedAt: TimestampSchema,
});
export type WorkspaceLayout = z.infer<typeof WorkspaceLayoutSchema>;

export const ExternalReferenceSchema = z.object({
  id: ExternalReferenceIdSchema,
  entityType: z.enum(['document', 'documentFile', 'collection', 'tag']),
  entityId: z.string().min(1),
  provider: z.literal('zotero'),
  /** Zotero item key or collection key. */
  externalKey: z.string().min(1),
  /** Zotero item version, used to skip unchanged records on refresh. */
  externalVersion: z.number().int().nonnegative().nullable(),
  payload: z.unknown(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ExternalReference = z.infer<typeof ExternalReferenceSchema>;

export const IndexingJobStatusSchema = z.enum([
  'queued',
  'running',
  'complete',
  'failed',
]);
export type IndexingJobStatus = z.infer<typeof IndexingJobStatusSchema>;

export const IndexingJobSchema = z.object({
  id: IndexingJobIdSchema,
  documentId: DocumentIdSchema,
  jobType: z.enum(['extract-text', 'index-fts']),
  status: IndexingJobStatusSchema,
  attempts: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
});
export type IndexingJob = z.infer<typeof IndexingJobSchema>;

// ---------------------------------------------------------------------------
// Library / search projections
// ---------------------------------------------------------------------------

export const LibraryItemSchema = z.object({
  document: DocumentSchema,
  files: z.array(DocumentFileRefSchema),
  tags: z.array(z.string()),
  collectionIds: z.array(CollectionIdSchema),
  annotationCount: z.number().int().nonnegative(),
  hasExtractedText: z.boolean(),
});
export type LibraryItem = z.infer<typeof LibraryItemSchema>;

export const SearchResultSchema = z.object({
  entityType: z.enum(['document', 'chunk', 'annotation', 'note']),
  entityId: z.string(),
  documentId: DocumentIdSchema.nullable(),
  title: z.string(),
  /** FTS5 snippet with matches wrapped in the configured delimiters. */
  snippet: z.string(),
  /** Plain-text snippet without markup, for accessibility labels. */
  plainSnippet: z.string(),
  /** Enough information to open and reveal the exact source location. */
  location: DocumentLocationSchema.nullable(),
  score: z.number(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchFiltersSchema = z.object({
  entityTypes: z.array(z.enum(['document', 'chunk', 'annotation', 'note'])).optional(),
  tags: z.array(z.string()).optional(),
  collectionIds: z.array(CollectionIdSchema).optional(),
  authors: z.array(z.string()).optional(),
  publishedAfter: z.string().optional(),
  publishedBefore: z.string().optional(),
  documentIds: z.array(DocumentIdSchema).optional(),
});
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

// ---------------------------------------------------------------------------
// The librarian
// ---------------------------------------------------------------------------

/**
 * The librarian's remit, as identifiers.
 *
 * Declared here, once, because three places need to agree on the list and they cannot all own
 * it: the prompt is built by appending one line per enabled capability, the proposal boundary
 * drops a proposal whose capability is off, and the interface offers the switches. `A09` is
 * only checkable if switching one off removes it everywhere, which a second copy of the list
 * quietly undoes. The line each capability contributes to the prompt stays in the main
 * process, where the prompt is assembled.
 */
export const LIBRARIAN_CAPABILITY_IDS = [
  'connect',
  'contradict',
  'evidence',
  'directions',
] as const;
export const LibrarianCapabilitySchema = z.enum(LIBRARIAN_CAPABILITY_IDS);
export type LibrarianCapabilityId = z.infer<typeof LibrarianCapabilitySchema>;

/** What a proposal claims to be. One kind per capability, and the boundary checks the pair. */
export const PROPOSAL_KIND_IDS = [
  'connection',
  'contradiction',
  'evidence',
  'direction',
] as const;
export const ProposalKindSchema = z.enum(PROPOSAL_KIND_IDS);
export type ProposalKindId = z.infer<typeof ProposalKindSchema>;

export const ProposalStatusSchema = z.enum(['pending', 'accepted', 'rejected']);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const AgentRunStatusSchema = z.enum(['running', 'finished', 'failed', 'cancelled']);
export const AgentRunTriggerSchema = z.enum(['schedule', 'import', 'manual']);

/**
 * A cited entity, already resolved against the database.
 *
 * There is no unresolved form: a citation that named nothing was refused at the boundary
 * before the proposal was stored, so everything the interface receives can be opened.
 * `documentId` and `location` are what make that opening land in the right place (`A10`).
 */
export const ProposalCitationSchema = z.object({
  entityType: LinkableEntityTypeSchema,
  entityId: z.string().min(1),
  title: z.string(),
  documentId: DocumentIdSchema.nullable(),
  location: DocumentLocationSchema.nullable().catch(null),
});
export type ProposalCitation = z.infer<typeof ProposalCitationSchema>;

export const AgentProposalSchema = z.object({
  id: AgentProposalIdSchema,
  runId: AgentRunIdSchema,
  kind: ProposalKindSchema,
  title: z.string(),
  body: z.string(),
  status: ProposalStatusSchema,
  citations: z.array(ProposalCitationSchema),
  /** The documents this note covers, so a later pass can decide whether the map is enough. */
  covers: z.array(ProposalCitationSchema),
  /** The wiki document an accepted proposal became. Null until it is accepted. */
  documentId: DocumentIdSchema.nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type AgentProposal = z.infer<typeof AgentProposalSchema>;

export const AgentRunSummarySchema = z.object({
  id: AgentRunIdSchema,
  status: AgentRunStatusSchema,
  trigger: AgentRunTriggerSchema,
  proposalCount: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AgentRunSummary = z.infer<typeof AgentRunSummarySchema>;

export const AgentStatusSchema = z.object({
  enabled: z.boolean(),
  capabilities: z.array(LibrarianCapabilitySchema),
  /** True once the disclosure has been read and accepted, which is what unlocks enabling. */
  disclosureAcknowledged: z.boolean(),
  running: z.boolean(),
  pendingProposals: z.number().int().nonnegative(),
  lastRun: AgentRunSummarySchema.nullable(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * What a run would send, and where.
 *
 * Computed from the database rather than written as prose in a component: the counts are the
 * ones `WikiView` would materialise, so the disclosure cannot drift away from the thing it
 * describes.
 */
export const AgentDisclosureSchema = z.object({
  agent: z.literal('librarian'),
  headline: z.string(),
  destination: z.string(),
  credentials: z.string(),
  sends: z.array(z.object({ what: z.string(), count: z.number().int().nonnegative() })),
  withholds: z.array(z.string()),
  tools: z.array(z.string()),
  capabilities: z.array(
    z.object({
      id: LibrarianCapabilitySchema,
      line: z.string(),
      /** Core capabilities are what the librarian is for; the rest are genuinely optional. */
      core: z.boolean(),
      enabled: z.boolean(),
    }),
  ),
  acknowledged: z.boolean(),
});
export type AgentDisclosure = z.infer<typeof AgentDisclosureSchema>;
