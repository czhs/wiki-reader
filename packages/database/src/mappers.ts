import {
  resolveHighlightColor,
  AnnotationAnchorSchema,
  AnnotationSchema,
  CollectionSchema,
  DocumentChunkSchema,
  DocumentLocationSchema,
  DocumentFileSchema,
  DocumentRevisionSchema,
  DocumentSchema,
  ExternalReferenceSchema,
  IndexingJobSchema,
  LinkSchema,
  NoteSchema,
  QuestionSchema,
  ReadingPositionSchema,
  TagSchema,
  WorkspaceLayoutSchema,
  type Annotation,
  type AnnotationAnchor,
  type Collection,
  type Document,
  type DocumentChunk,
  type DocumentFile,
  type DocumentLocation,
  type DocumentRevision,
  type ExternalReference,
  type IndexingJob,
  type Link,
  type Note,
  type Question,
  type ReadingPosition,
  type Tag,
  type WorkspaceLayout,
} from '@wr/shared-types';

/**
 * Row shapes and row -> domain conversion.
 *
 * Every read goes through a zod schema. That costs a little on large result sets but
 * means a schema drift or a hand-edited database surfaces as a validation error at the
 * repository boundary instead of as a mystery `undefined` three layers up.
 */

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export function parseJsonOrNull(text: string | null): unknown {
  return text === null ? null : parseJson(text);
}

/** JSON round-trip for a nullable DocumentLocation column. */
export function parseLocation(text: string | null): DocumentLocation | null {
  if (text === null) return null;
  return DocumentLocationSchema.parse(parseJson(text));
}

export function serializeLocation(location: DocumentLocation | null | undefined): string | null {
  return location === null || location === undefined ? null : JSON.stringify(location);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface DocumentRow {
  id: string;
  title: string;
  doc_type: string;
  authors_json: string;
  abstract: string | null;
  published_date: string | null;
  source: string;
  slug?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function toDocument(row: DocumentRow): Document {
  return DocumentSchema.parse({
    id: row.id,
    title: row.title,
    docType: row.doc_type,
    authors: parseJson(row.authors_json),
    abstract: row.abstract,
    publishedDate: row.published_date,
    source: row.source,
    slug: row.slug ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  });
}

export interface DocumentFileRow {
  id: string;
  document_id: string;
  revision_id: string | null;
  path: string;
  mime_type: string;
  byte_size: number;
  content_hash: string;
  role: string;
  created_at: string;
}

export function toDocumentFile(row: DocumentFileRow): DocumentFile {
  return DocumentFileSchema.parse({
    id: row.id,
    documentId: row.document_id,
    revisionId: row.revision_id,
    path: row.path,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    contentHash: row.content_hash,
    role: row.role,
    createdAt: row.created_at,
  });
}

export interface DocumentRevisionRow {
  id: string;
  document_id: string;
  revision_no: number;
  content_hash: string;
  extracted_text_hash: string | null;
  created_at: string;
}

export function toDocumentRevision(row: DocumentRevisionRow): DocumentRevision {
  return DocumentRevisionSchema.parse({
    id: row.id,
    documentId: row.document_id,
    revisionNo: row.revision_no,
    contentHash: row.content_hash,
    extractedTextHash: row.extracted_text_hash,
    createdAt: row.created_at,
  });
}

export interface DocumentChunkRow {
  id: string;
  document_id: string;
  revision_id: string;
  chunk_index: number;
  kind: string;
  page_index: number | null;
  section_path: string | null;
  char_start: number;
  char_end: number;
  text: string;
}

export function toDocumentChunk(row: DocumentChunkRow): DocumentChunk {
  return DocumentChunkSchema.parse({
    id: row.id,
    documentId: row.document_id,
    revisionId: row.revision_id,
    chunkIndex: row.chunk_index,
    kind: row.kind,
    pageIndex: row.page_index,
    sectionPath: row.section_path,
    charStart: row.char_start,
    charEnd: row.char_end,
    text: row.text,
  });
}

// ---------------------------------------------------------------------------
// Annotations and notes
// ---------------------------------------------------------------------------

export interface AnnotationRow {
  id: string;
  document_id: string;
  revision_id: string | null;
  kind: string;
  color: string;
  selected_text: string;
  comment: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function toAnnotation(row: AnnotationRow): Annotation {
  return AnnotationSchema.parse({
    id: row.id,
    documentId: row.document_id,
    revisionId: row.revision_id,
    kind: row.kind,
    // The one place a stored colour is interpreted. Rows predating the palette hold a hex
    // literal and read back as `default`; every write since goes through the enum, so the
    // column converges on names as annotations are edited.
    color: resolveHighlightColor(row.color),
    selectedText: row.selected_text,
    comment: row.comment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  });
}

export interface AnnotationAnchorRow {
  id: string;
  annotation_id: string;
  kind: string;
  anchor_json: string;
  page_index: number | null;
  section_path: string | null;
  text_hash: string;
  content_hash: string;
  created_at: string;
}

export function toAnnotationAnchor(row: AnnotationAnchorRow): AnnotationAnchor {
  return AnnotationAnchorSchema.parse(parseJson(row.anchor_json));
}

export interface NoteRow {
  id: string;
  title: string;
  content_json: string;
  content_text: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function toNote(row: NoteRow): Note {
  return NoteSchema.parse({
    id: row.id,
    title: row.title,
    contentJson: parseJson(row.content_json),
    contentText: row.content_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  });
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export interface QuestionRow {
  id: string;
  title: string;
  status: string;
  ordinal: number;
  importance: number | null;
  next_action: string | null;
  discarded_reason: string | null;
  started_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toQuestion(row: QuestionRow): Question {
  return QuestionSchema.parse({
    id: row.id,
    title: row.title,
    status: row.status,
    ordinal: row.ordinal,
    importance: row.importance,
    nextAction: row.next_action,
    discardedReason: row.discarded_reason,
    startedAt: row.started_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export interface LinkRow {
  id: string;
  type: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  source_location_json: string | null;
  target_location_json: string | null;
  label: string | null;
  ordinal: number | null;
  origin: string;
  generator: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export function toLink(row: LinkRow): Link {
  return LinkSchema.parse({
    id: row.id,
    type: row.type,
    sourceType: row.source_type,
    sourceId: row.source_id,
    targetType: row.target_type,
    targetId: row.target_id,
    sourceLocation: parseLocation(row.source_location_json),
    targetLocation: parseLocation(row.target_location_json),
    label: row.label,
    ordinal: row.ordinal,
    origin: row.origin,
    generator: row.generator,
    metadata: parseJsonOrNull(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

// ---------------------------------------------------------------------------
// Organisation and session state
// ---------------------------------------------------------------------------

export interface CollectionRow {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export function toCollection(row: CollectionRow): Collection {
  return CollectionSchema.parse({
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export interface TagRow {
  id: string;
  name: string;
}

export function toTag(row: TagRow): Tag {
  return TagSchema.parse({ id: row.id, name: row.name });
}

export interface ReadingPositionRow {
  document_id: string;
  location_json: string;
  updated_at: string;
}

export function toReadingPosition(row: ReadingPositionRow): ReadingPosition {
  return ReadingPositionSchema.parse({
    documentId: row.document_id,
    location: parseJson(row.location_json),
    updatedAt: row.updated_at,
  });
}

export interface WorkspaceLayoutRow {
  name: string;
  layout_json: string;
  panel_state_json: string;
  updated_at: string;
}

export function toWorkspaceLayout(row: WorkspaceLayoutRow): WorkspaceLayout {
  return WorkspaceLayoutSchema.parse({
    name: row.name,
    layout: parseJson(row.layout_json),
    panelState: parseJson(row.panel_state_json),
    updatedAt: row.updated_at,
  });
}

export interface ExternalReferenceRow {
  id: string;
  entity_type: string;
  entity_id: string;
  provider: string;
  external_key: string;
  external_version: number | null;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
}

export function toExternalReference(row: ExternalReferenceRow): ExternalReference {
  return ExternalReferenceSchema.parse({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    provider: row.provider,
    externalKey: row.external_key,
    externalVersion: row.external_version,
    payload: parseJsonOrNull(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export interface IndexingJobRow {
  id: string;
  document_id: string;
  job_type: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function toIndexingJob(row: IndexingJobRow): IndexingJob {
  return IndexingJobSchema.parse({
    id: row.id,
    documentId: row.document_id,
    jobType: row.job_type,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}
