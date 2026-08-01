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

/** A calendar day, `YYYY-MM-DD`. A journal's identity, not a timestamp. */
export const JournalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'a journal date is an ISO calendar day, YYYY-MM-DD');
export type JournalDate = z.infer<typeof JournalDateSchema>;

// ---------------------------------------------------------------------------
// Notebooks — the queue
//
// `questions` is what the row is called in SQLite and on the wire, and that is deliberate:
// renaming a released table and eleven channels would rewrite history without changing a
// single thing the researcher sees. What retires in milestone 5 is the *word* — no surface
// asks anyone what a question is. The unit is the notebook, everywhere it is spoken aloud.
// ---------------------------------------------------------------------------

/**
 * Which list a notebook appears in. `discarded` is not a delete: the notebook and the
 * reason it was dropped are the useful residue of having opened it.
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
  /**
   * The day this notebook's journal begins (`P03`), or `null` for "work it out".
   *
   * Set by the researcher, because only they know when the work started: a notebook opened
   * today to hold six months of reading has a calendar that begins in January, and one made
   * this morning does not want a year of empty days in front of it. Null is not a missing
   * value — it is the notebook saying nobody has claimed a date, and the calendar then starts
   * at the day the notebook was made or at its oldest entry, whichever is earlier.
   */
  journalStart: JournalDateSchema.nullable(),
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

/**
 * A claim as something to point evidence at, wherever in the library it was made (`E02`).
 *
 * A hypothesis has no row in `documents` or `notes`, so nothing that lists "the library" can
 * reach one — which is the whole of why the link picker could offer files and highlights and
 * never a claim. It carries its notebook's title because a statement out of its notebook is
 * half an answer: two lines of work can both be claiming something about spacing.
 */
export const HypothesisInNotebookSchema = z.object({
  hypothesis: HypothesisSchema,
  notebookTitle: z.string(),
});
export type HypothesisInNotebook = z.infer<typeof HypothesisInNotebookSchema>;

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

/**
 * One day of a notebook's log.
 *
 * There is no entry for an unlogged day: blanking one deletes it. "No entry" and "an empty
 * entry" are the same fact, and a calendar that showed them differently would be lying.
 *
 * A day belongs to a notebook (`P02`). The journal was one global stream until milestone 5,
 * which made "what did I do on the 4th?" a question about the whole library rather than about
 * the work in hand — and made two lines of thought share one page.
 */
export const JournalEntrySchema = z.object({
  /** Whose log this day is. The notebook is the unit; a day with no notebook cannot exist. */
  notebookId: QuestionIdSchema,
  date: JournalDateSchema,
  /** Markdown source, as typed. */
  markdown: z.string().min(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/**
 * How a day is addressed as a link endpoint: `<notebook id>:<date>`.
 *
 * A day used to be addressed by its date alone, which stopped identifying anything once a
 * date could name a day in any of several notebooks. It is still a *natural* key rather than
 * a minted id, on purpose — the reason migration 005 gave holds: blanking a day deletes its
 * row, and an edge pointing at "the 4th of March in this notebook" must survive that and
 * mean the same thing when the day is written again.
 */
export const JOURNAL_ENTITY_SEPARATOR = ':';

export function journalEntityId(notebookId: string, date: string): string {
  return `${notebookId}${JOURNAL_ENTITY_SEPARATOR}${date}`;
}

/** The notebook and day inside a journal endpoint id, or `null` if it is not one. */
export function parseJournalEntityId(
  entityId: string,
): { readonly notebookId: string; readonly date: string } | null {
  const at = entityId.lastIndexOf(JOURNAL_ENTITY_SEPARATOR);
  if (at <= 0) return null;
  const notebookId = entityId.slice(0, at);
  const date = entityId.slice(at + 1);
  if (!QuestionIdSchema.safeParse(notebookId).success) return null;
  if (!JournalDateSchema.safeParse(date).success) return null;
  return { notebookId, date };
}

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
  /**
   * A highlight the researcher pointed at a whole file (`H02`).
   *
   * Deliberately *not* `annotation-belongs-to-document`, which every highlight already carries
   * to the paper it was made in — written automatically, `origin: 'derived'`. Reusing it would
   * mean "link this highlight to that paper" silently returned the existing containment edge
   * whenever the paper happened to be its own (`LinksRepository.create` is idempotent on
   * type + endpoints), and afterwards nothing could tell an assertion from a fact.
   */
  'annotation-references-document',
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

/**
 * One line of a file's ledger (`H03`): an edge, and which end of it is inside this file.
 *
 * A `ResolvedLink` describes the endpoint *away* from whatever the query was about, which for
 * a whole-file question is ambiguous — the edge may hang off the file itself, off a sentence
 * marked in it, or off one of its indexed chunks. `near` is that answer, so a ledger can say
 * "this is on the paper" and "this is on the sentence you marked" without inferring it back
 * out of the row.
 */
export const DocumentLedgerEntrySchema = z.object({
  near: z.object({
    entityType: LinkableEntityTypeSchema,
    entityId: z.string().min(1),
    /** How the near end reads: the file's title, or the highlight's own words. */
    label: z.string(),
  }),
  link: ResolvedLinkSchema,
});
export type DocumentLedgerEntry = z.infer<typeof DocumentLedgerEntrySchema>;

/**
 * A sentence marked in the file, whether or not anything has been said about it yet (`E03`).
 *
 * The entries above are edges, so a highlight nobody has linked produces none of them and was
 * invisible on the one page whose reason for existing is that seeing what a paper is connected
 * to is when you notice what it should be connected to. This list is the file's highlights as
 * the file knows them — read from `annotations`, not minted from `links` — so the ledger can
 * offer *every* marked sentence as a place to start a link from.
 *
 * `links` is how many of the ledger's own entries hang off it, counted under the same rules the
 * entries are gathered under, so a ledger cannot say "3 links" over a group of two rows.
 */
export const DocumentLedgerHighlightSchema = z.object({
  annotationId: AnnotationIdSchema,
  /** The highlight's own words, which is how it reads in a list. */
  label: z.string(),
  links: z.number().int().nonnegative(),
});
export type DocumentLedgerHighlight = z.infer<typeof DocumentLedgerHighlightSchema>;

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
 * One card on a question's desk board.
 *
 * A card *is* an edge — the `question-references-…` link that already relates the question to
 * the paper or the highlight — so `linkId` is its identity and there is no card table behind
 * it. Taking a card off the board and deleting the relationship are the same act, which is
 * the property a separate table would quietly lose.
 *
 * `position` is null until the card has been *dragged*. A board arranges untouched cards
 * however it likes; recording a default the moment one appears would store a decision nobody
 * made and then be unable to improve on it.
 */
export const BoardCardSchema = z.object({
  linkId: LinkIdSchema,
  /** What the card stands for: a document or a highlight. */
  entityType: LinkableEntityTypeSchema,
  entityId: z.string().min(1),
  title: z.string(),
  /** Why it is on the board, when the researcher said so. */
  label: z.string().nullable(),
  /** The other end no longer resolves — shown as a card with a hole in it, never dropped. */
  broken: z.boolean(),
  /** Where to open it, when it has a precise location. */
  documentId: DocumentIdSchema.nullable(),
  location: DocumentLocationSchema.nullable(),
  position: z.object({ x: z.number(), y: z.number() }).nullable(),
});
export type BoardCard = z.infer<typeof BoardCardSchema>;

/**
 * The page behind a question: its front matter, its prose, its claims and its board.
 *
 * `body` is markdown *source*, as typed. Nothing renders it on the way in or out — prose
 * stored as anything but its source is prose only one editor can read.
 */
export const NotebookPageSchema = z.object({
  question: QuestionSchema,
  body: z.string(),
  hypotheses: z.array(HypothesisWithEvidenceSchema),
  /** The desk board, in the order the edges were made. */
  cards: z.array(BoardCardSchema),
});
export type NotebookPage = z.infer<typeof NotebookPageSchema>;

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/** A container node, addressed the way every other node is: by type and id. */
export const GraphNodeParentSchema = z.object({
  entityType: LinkableEntityTypeSchema,
  entityId: z.string().min(1),
});
export type GraphNodeParent = z.infer<typeof GraphNodeParentSchema>;

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
  /**
   * What the researcher renamed this node to, or null for one nobody has renamed.
   *
   * Sent beside `title` rather than replacing it: the title is what the thing is called, and
   * writing a graph label into it would put the name somewhere the next Zotero import
   * overwrites (`G03`).
   */
  displayName: z.string().nullable().default(null),
  /**
   * The picture on the node, as a file id — `rrfile://<id>` — or null for a plain disc.
   *
   * A file id and never a path, exactly as a notebook's cover is (`G04`): the renderer draws
   * the image by addressing it, and cannot say where on the disk it came from.
   */
  iconFileId: DocumentFileIdSchema.nullable().default(null),
  /** The document to open when the node is activated; null for entities without one. */
  documentId: DocumentIdSchema.nullable(),
  /**
   * The node this one is drawn *inside* — a highlight's paper — or null for one standing alone.
   *
   * Containment is a fact the traversal knows and the view would otherwise have to guess at
   * from how long an edge came out (`G06`): a highlight belongs to the document it was made in,
   * so the answer says so rather than leaving the reader to infer it. Set only when the
   * container is itself in this bounded neighbourhood; a parent nobody was sent is no parent,
   * because the view cannot draw a box around something it does not have.
   */
  parent: GraphNodeParentSchema.nullable().default(null),
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

/**
 * One node of the whole-corpus view.
 *
 * The neighbourhood node without its `distance`: there is no seed here to be a hop away from,
 * and a field that could only ever say `0` is a field the view would be tempted to lay itself
 * out by. Rank is the order the nodes arrive in instead — a property of the answer, not of a
 * number copied onto every row of it.
 */
export const GraphOverviewNodeSchema = GraphNodeSchema.omit({ distance: true }).extend({
  /**
   * A marked sentence's own words, or null for a node that is a file (`V01`).
   *
   * The wiki draws highlights now, and a disc with a title under it cannot say which kind of
   * thing it stands for: the researcher asked that a highlight arrive carrying a little of the
   * text that was highlighted, *so it is easy to tell apart from a page node*. So the words
   * are the payload rather than a decoration — the same excerpt the focused view and the peek
   * widget resolve, and the thing the map's own filter matches on (`V02`).
   */
  snippet: z.string().nullable().default(null),
});
export type GraphOverviewNode = z.infer<typeof GraphOverviewNodeSchema>;

/**
 * The library as a place: its files, its notes, the marked sentences that have become
 * structure, and the edges between them (`F01`, `V01`).
 *
 * Deliberately *not* the neighbourhood channel with the seed taken off.
 *
 * It carried no highlights at all until the researcher reversed that: a corpus drawn with
 * *every* highlight in the library is a picture of the annotations rather than of the wiki, but
 * a map that showed none of them drew two papers joined because a sentence in one bears on a
 * sentence in the other (`H02`) exactly like two papers that have never met. So the rule is
 * neither — a highlight is on the map once something links it, which is the moment it stopped
 * being a note to oneself and became part of the shape of the corpus. Where a highlight sits
 * *inside* its paper remains the focused view's subject (`F02`).
 *
 * And it is capped: `nodes` is the top of a ranking, `totalNodes` is how many
 * there are, and `elidedNodes` is the difference, so a truncated map says so on its face
 * instead of presenting a slice as the library.
 *
 * Both halves are capped, and that is not symmetry for its own sake. Lines are their own
 * quantity: three hundred discs of a dense library carry tens of thousands of them, each one
 * serialised over IPC and drawn as its own element, and a cap with no counter beside it was how
 * a map missing a line between two files it had drawn presented itself as complete.
 */
export const GraphOverviewSchema = z.object({
  /** Ranked: the most connected first. The order *is* the layout's input. */
  nodes: z.array(GraphOverviewNodeSchema),
  /** Every link with both ends drawn, oldest first, up to the caller's edge cap. */
  edges: z.array(GraphEdgeSchema),
  /** Everything the map could have drawn — files, notes and linked highlights — not only what fit. */
  totalNodes: z.number().int().nonnegative(),
  elidedNodes: z.number().int().nonnegative(),
  /** Every link between two drawn nodes, not only the ones that fit. */
  totalEdges: z.number().int().nonnegative(),
  elidedEdges: z.number().int().nonnegative(),
  /** True when anything was left out, of either kind. */
  truncated: z.boolean(),
});
export type GraphOverview = z.infer<typeof GraphOverviewSchema>;

/** One highlight in the middle of a focused view: what it says, and where it opens. */
export const GraphFocusAnnotationSchema = z.object({
  entityId: AnnotationIdSchema,
  title: z.string(),
  /**
   * The highlight's own words.
   *
   * The centre of a focused view is what this paper *says*, so the node carries the sentence
   * rather than only a count. It is the same excerpt the link and peek surfaces resolve, so
   * there is one answer to "what does this highlight read as".
   */
  excerpt: z.string(),
  location: DocumentLocationSchema.nullable(),
  displayName: z.string().nullable().default(null),
  iconFileId: DocumentFileIdSchema.nullable().default(null),
  degree: z.number().int().nonnegative(),
});
export type GraphFocusAnnotation = z.infer<typeof GraphFocusAnnotationSchema>;

/** One file at the edge of a focused view: what it is, and how it got there. */
export const GraphFocusNeighbourSchema = z.object({
  documentId: DocumentIdSchema,
  title: z.string(),
  displayName: z.string().nullable().default(null),
  iconFileId: DocumentFileIdSchema.nullable().default(null),
  degree: z.number().int().nonnegative(),
  /** Edges between this file and the focused one, counting those through either's highlights. */
  connections: z.number().int().positive(),
  /**
   * True when nothing joins the two files directly and the connection runs through a
   * highlight — the shape a library actually grows, where one marked sentence answers another.
   */
  throughAnnotation: z.boolean(),
});
export type GraphFocusNeighbour = z.infer<typeof GraphFocusNeighbourSchema>;

/**
 * One file in the middle, what it says around it, where it leads at the edges (`F02`, `F03`).
 *
 * Two budgets rather than one node cap, and that is the point of the shape: highlights and
 * connected files are ranked and elided *separately*, so a paper with sixty highlights still
 * shows where it leads and a paper in a dense corpus still shows what it says. A single cap
 * over both would let whichever sorts first starve the other, and the half that got starved is
 * exactly the half the criterion is about.
 */
export const GraphFocusSchema = z.object({
  focus: z.object({
    documentId: DocumentIdSchema,
    title: z.string(),
    displayName: z.string().nullable().default(null),
    iconFileId: DocumentFileIdSchema.nullable().default(null),
    degree: z.number().int().nonnegative(),
  }),
  /** Its own highlights, in reading order. */
  annotations: z.array(GraphFocusAnnotationSchema),
  /** The files it reaches, most-connected first. */
  neighbours: z.array(GraphFocusNeighbourSchema),
  elidedAnnotations: z.number().int().nonnegative(),
  elidedNeighbours: z.number().int().nonnegative(),
});
export type GraphFocus = z.infer<typeof GraphFocusSchema>;

/**
 * How the graph is drawn — one view, not one per panel.
 *
 * Spacing, labels and depth are preferences about reading a graph, not facts about a
 * particular panel: someone who wants two hops and no labels wants that of the next graph
 * they open too. So they live here, application-wide, and the panel descriptor carries only
 * the seed. `depth` is bounded to the same maximum the `graph:neighbourhood` request is, so a
 * stored preference can never widen a query past what the contract allows.
 */
export const GraphViewSettingsSchema = z.object({
  /** Multiplies each node's distance from the centre. 1 is the layout's own spacing. */
  spacing: z.number().min(0.5).max(2.5).default(1),
  showLabels: z.boolean().default(true),
  depth: z.number().int().positive().max(3).default(1),
});
export type GraphViewSettings = z.infer<typeof GraphViewSettingsSchema>;

/**
 * Where a graph was left: the pan offset in layout units and the zoom factor.
 *
 * Kept per seed rather than per panel. A panel id is gone the moment the tab closes, and
 * "the view survives reopening the panel" has to mean the graph *on this paper* comes back
 * where it was left — which is a fact about the seed.
 */
export const GraphViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number().min(0.2).max(5),
});
export type GraphViewport = z.infer<typeof GraphViewportSchema>;

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
  /**
   * When this key was removed from the library on purpose, or null.
   *
   * A tombstone rather than a deleted row: the next import reads it and skips the item, so
   * "I took this out" survives a refresh instead of being undone by one (criterion B01).
   */
  removedAt: TimestampSchema.nullable(),
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

/**
 * Whether the app may fetch art for a graph node, and how much it has kept (criterion G05).
 *
 * `host` travels with the switch rather than being written into a component, because it is the
 * whole content of the promise: card art is the second exception to local-first, and it is
 * bounded to one host. A panel that named a different one would be stating something untrue
 * about what this application does.
 */
export const CardArtStatusSchema = z.object({
  enabled: z.boolean(),
  disclosureAcknowledged: z.boolean(),
  host: z.string(),
  /** Pictures already on this disk. Each one is a request that will never be made again. */
  cached: z.number().int().nonnegative(),
});
export type CardArtStatus = z.infer<typeof CardArtStatusSchema>;

/** What a card-art fetch would send, and where. The same shape the librarian's disclosure has. */
export const CardArtDisclosureSchema = z.object({
  host: z.string(),
  headline: z.string(),
  destination: z.string(),
  sends: z.array(z.string()),
  withholds: z.array(z.string()),
  cached: z.number().int().nonnegative(),
  acknowledged: z.boolean(),
});
export type CardArtDisclosure = z.infer<typeof CardArtDisclosureSchema>;
