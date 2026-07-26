import { z } from 'zod';

/**
 * Internal IDs are opaque, stable, and independent of filesystem paths and Zotero
 * database internals. They are branded so a DocumentId cannot be passed where an
 * AnnotationId is expected.
 *
 * Format: `<prefix>_<26 lowercase base32 chars>` (ULID-like, lexicographically sortable
 * by creation time). Minting lives in @wr/document-model; this package only describes
 * the shape.
 */

const ID_BODY = /^[0-9a-hjkmnp-tv-z]{26}$/;

const branded = <B extends string>(prefix: string, brand: B) =>
  z
    .string()
    .refine(
      (value) => {
        const [head, body, ...rest] = value.split('_');
        return rest.length === 0 && head === prefix && body !== undefined && ID_BODY.test(body);
      },
      { message: `expected a ${brand} of the form ${prefix}_<26 chars>` },
    )
    .brand<B>();

export const DocumentIdSchema = branded('doc', 'DocumentId');
export const DocumentFileIdSchema = branded('dfl', 'DocumentFileId');
export const DocumentRevisionIdSchema = branded('drv', 'DocumentRevisionId');
export const DocumentChunkIdSchema = branded('chk', 'DocumentChunkId');
export const AnnotationIdSchema = branded('ann', 'AnnotationId');
export const AnnotationAnchorIdSchema = branded('anc', 'AnnotationAnchorId');
export const NoteIdSchema = branded('not', 'NoteId');
export const LinkIdSchema = branded('lnk', 'LinkId');
export const CollectionIdSchema = branded('col', 'CollectionId');
export const TagIdSchema = branded('tag', 'TagId');
export const ExternalReferenceIdSchema = branded('ext', 'ExternalReferenceId');
export const IndexingJobIdSchema = branded('job', 'IndexingJobId');
export const QuestionIdSchema = branded('qst', 'QuestionId');
export const AgentRunIdSchema = branded('agr', 'AgentRunId');
export const AgentProposalIdSchema = branded('apr', 'AgentProposalId');

export type DocumentId = z.infer<typeof DocumentIdSchema>;
export type DocumentFileId = z.infer<typeof DocumentFileIdSchema>;
export type DocumentRevisionId = z.infer<typeof DocumentRevisionIdSchema>;
export type DocumentChunkId = z.infer<typeof DocumentChunkIdSchema>;
export type AnnotationId = z.infer<typeof AnnotationIdSchema>;
export type AnnotationAnchorId = z.infer<typeof AnnotationAnchorIdSchema>;
export type NoteId = z.infer<typeof NoteIdSchema>;
export type LinkId = z.infer<typeof LinkIdSchema>;
export type CollectionId = z.infer<typeof CollectionIdSchema>;
export type TagId = z.infer<typeof TagIdSchema>;
export type ExternalReferenceId = z.infer<typeof ExternalReferenceIdSchema>;
export type IndexingJobId = z.infer<typeof IndexingJobIdSchema>;
export type QuestionId = z.infer<typeof QuestionIdSchema>;
export type AgentRunId = z.infer<typeof AgentRunIdSchema>;
export type AgentProposalId = z.infer<typeof AgentProposalIdSchema>;

/** ID prefixes by entity kind, used by the minting helpers and by link parsing. */
export const ID_PREFIXES = {
  document: 'doc',
  documentFile: 'dfl',
  documentRevision: 'drv',
  documentChunk: 'chk',
  annotation: 'ann',
  annotationAnchor: 'anc',
  note: 'not',
  link: 'lnk',
  collection: 'col',
  tag: 'tag',
  externalReference: 'ext',
  indexingJob: 'job',
  question: 'qst',
  agentRun: 'agr',
  agentProposal: 'apr',
} as const;

export type EntityKind = keyof typeof ID_PREFIXES;
