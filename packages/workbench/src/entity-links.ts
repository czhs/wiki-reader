import {
  extractInternalLinks,
  formatInternalLink,
  internalLinkTarget,
  mintId,
} from '@wr/document-model';
import type {
  AnnotationId,
  DocumentId,
  DocumentLocation,
  InternalLink,
  LinkableEntityType,
  Link,
  LinkType,
  NoteId,
  Timestamp,
} from '@wr/shared-types';

/**
 * Typed links between notes, annotations and documents.
 *
 * Every relationship in the app is a directed edge with a semantic type — there is no
 * untyped backlink table. That is what makes "find all references" answerable by direction
 * and by kind rather than as one undifferentiated pile, and it is why link type is derived
 * from the endpoint types here in one place instead of being guessed at each call site.
 *
 * Criterion L01: internal links between notes, annotations, and documents.
 */

export class UnsupportedLinkError extends Error {
  constructor(sourceType: LinkableEntityType, targetType: LinkableEntityType) {
    super(`no canonical link type from \`${sourceType}\` to \`${targetType}\``);
    this.name = 'UnsupportedLinkError';
  }
}

/**
 * The canonical link type for a pair of endpoints.
 *
 * Returns `null` where no specific type applies; callers then either fall back to
 * `related-to` or reject, depending on whether the user asked for the link explicitly.
 */
export function canonicalLinkType(
  sourceType: LinkableEntityType,
  targetType: LinkableEntityType,
): LinkType | null {
  if (sourceType === 'note') {
    if (targetType === 'document') return 'note-references-document';
    if (targetType === 'note') return 'note-references-note';
    if (targetType === 'annotation') return 'note-references-annotation';
  }
  if (sourceType === 'annotation') {
    if (targetType === 'annotation') return 'annotation-references-annotation';
    if (targetType === 'document') return 'annotation-belongs-to-document';
  }
  if (sourceType === 'document' && targetType === 'document') return 'document-cites-document';
  if (sourceType === 'excerpt' && targetType === 'annotation') return 'excerpt-derived-from-annotation';
  return null;
}

export interface EntityRef {
  readonly entityId: string;
  readonly entityType: LinkableEntityType;
  /** The document this entity lives in, when it has one. */
  readonly documentId?: DocumentId;
  readonly location?: DocumentLocation;
}

export interface LinkDraftInput {
  readonly source: EntityRef;
  readonly target: EntityRef;
  /** Overrides the canonical type; required for relationships with no canonical form. */
  readonly type?: LinkType;
  readonly label?: string;
  readonly ordinal?: number;
  readonly origin?: 'manual' | 'derived';
  readonly generator?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly now: Timestamp;
}

/**
 * Build a complete `Link` ready to persist. Throws when no type is given and none can be
 * derived: silently writing a `related-to` edge would erase the distinction the link model
 * exists to preserve.
 */
export function createLinkDraft(input: LinkDraftInput): Link {
  const type = input.type ?? canonicalLinkType(input.source.entityType, input.target.entityType);
  if (type === null || type === undefined) {
    throw new UnsupportedLinkError(input.source.entityType, input.target.entityType);
  }

  return {
    id: mintId('link') as Link['id'],
    type,
    sourceId: input.source.entityId,
    sourceType: input.source.entityType,
    targetId: input.target.entityId,
    targetType: input.target.entityType,
    sourceLocation: input.source.location ?? null,
    targetLocation: input.target.location ?? null,
    label: input.label ?? null,
    ordinal: input.ordinal ?? null,
    origin: input.origin ?? 'manual',
    generator: input.generator ?? null,
    metadata: input.metadata === undefined ? null : { ...input.metadata },
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** The endpoint of a link that is *not* the entity being queried. */
export function otherEndpoint(link: Link, entityId: string): EntityRef & { direction: 'incoming' | 'outgoing' } {
  if (link.sourceId === entityId) {
    const ref: EntityRef & { direction: 'incoming' | 'outgoing' } = {
      entityId: link.targetId,
      entityType: link.targetType,
      direction: 'outgoing',
    };
    return link.targetLocation === null ? ref : { ...ref, location: link.targetLocation };
  }
  const ref: EntityRef & { direction: 'incoming' | 'outgoing' } = {
    entityId: link.sourceId,
    entityType: link.sourceType,
    direction: 'incoming',
  };
  return link.sourceLocation === null ? ref : { ...ref, location: link.sourceLocation };
}

/** An entity as an internal link string, for "Copy Internal Link". */
export function internalLinkFor(entity: EntityRef): string | null {
  switch (entity.entityType) {
    case 'document': {
      const link: InternalLink =
        entity.location === undefined
          ? { scheme: 'document', documentId: entity.entityId as DocumentId }
          : {
              scheme: 'document',
              documentId: entity.entityId as DocumentId,
              location: entity.location,
            };
      return formatInternalLink(link);
    }
    case 'annotation':
      return formatInternalLink({
        scheme: 'annotation',
        annotationId: entity.entityId as AnnotationId,
      });
    case 'note': {
      const location = entity.location;
      return formatInternalLink(
        location !== undefined && location.kind === 'note'
          ? { scheme: 'note', noteId: entity.entityId as NoteId, location }
          : { scheme: 'note', noteId: entity.entityId as NoteId },
      );
    }
    default:
      // Chunks, headings, figures and citations are addressed through their document.
      return null;
  }
}

/** The entity an internal link points at. */
export function entityRefFromInternalLink(link: InternalLink): EntityRef {
  const target = internalLinkTarget(link);
  if (link.scheme === 'document') {
    return link.location === undefined
      ? { entityId: target.entityId, entityType: 'document', documentId: link.documentId }
      : {
          entityId: target.entityId,
          entityType: 'document',
          documentId: link.documentId,
          location: link.location,
        };
  }
  if (link.scheme === 'note' && link.location !== undefined) {
    return { entityId: target.entityId, entityType: 'note', location: link.location };
  }
  return { entityId: target.entityId, entityType: target.entityType };
}

export interface DerivedNoteLinksInput {
  readonly noteId: NoteId;
  /** The note's text content. Internal links are scanned out of it. */
  readonly content: string;
  readonly now: Timestamp;
  readonly generator?: string;
}

/**
 * Derive the typed links implied by a note's content.
 *
 * A note that mentions `document://doc_…` references that document, and the reference
 * survives editing because it is re-derived from the content rather than tracked by hand.
 * Duplicates within one note collapse to a single edge: mentioning a paper three times is
 * one relationship, not three.
 */
export function derivedLinksFromNote(input: DerivedNoteLinksInput): Link[] {
  const source: EntityRef = { entityId: input.noteId, entityType: 'note' };
  const seen = new Set<string>();
  const links: Link[] = [];

  for (const internal of extractInternalLinks(input.content)) {
    const target = entityRefFromInternalLink(internal);
    if (target.entityId === input.noteId) continue; // a note referencing itself is noise

    const key = `${target.entityType}:${target.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    links.push(
      createLinkDraft({
        source,
        target,
        origin: 'derived',
        generator: input.generator ?? 'note-content-scanner',
        now: input.now,
      }),
    );
  }

  return links;
}

/**
 * Reconcile derived links after a note is edited: what to insert, what to delete.
 *
 * Existing edges are matched by endpoint rather than by id so an unchanged mention keeps
 * its original link id — and therefore its creation time and any user annotations on it.
 */
export function diffDerivedLinks(
  existing: readonly Link[],
  desired: readonly Link[],
): { readonly toInsert: readonly Link[]; readonly toDelete: readonly Link[] } {
  const key = (link: Link): string => `${link.type}:${link.sourceId}:${link.targetId}`;
  const existingByKey = new Map(existing.map((link) => [key(link), link]));
  const desiredKeys = new Set(desired.map(key));

  return {
    toInsert: desired.filter((link) => !existingByKey.has(key(link))),
    toDelete: existing.filter((link) => !desiredKeys.has(key(link))),
  };
}
