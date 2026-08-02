import {
  describeLocation,
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

/**
 * The relationships that *may* be asserted between two documents.
 *
 * Read as a guard, not as a menu. Until milestone 7 the picker put these three on screen and
 * refused to make a link until one was chosen — and the researcher's verdict on that was that
 * they never once wanted to be asked (`H05`): a link is a link, and being made to name a kind
 * before two papers could be connected was a toll on the gesture that mattered. So the UI stops
 * asking and the table keeps its types: an edge nobody typed is written `related-to`, and this
 * list is what still bounds an explicit type arriving from a caller that does know.
 */
export const DOCUMENT_LINK_TYPES: readonly LinkType[] = [
  'document-cites-document',
  'related-to',
  'child-of',
];

/**
 * The relationships offered when the thing being linked *from* is a highlight (`H02`).
 *
 * `annotation-belongs-to-document` is missing on purpose, and its absence is the whole point.
 * Every highlight already carries that edge to the paper it was made in — the annotations
 * repository writes it, `origin: 'derived'` — and `LinksRepository.create` returns the
 * existing row rather than erroring on a repeat. Offering it here would mean a researcher
 * saying "this sentence bears on that paper" got, in the one case where the paper is the
 * highlight's own, the containment edge back with a success message. What they meant is
 * `annotation-references-document`: an assertion, `origin: 'manual'`, theirs.
 */
export const ANNOTATION_TO_DOCUMENT_LINK_TYPES: readonly LinkType[] = [
  'annotation-references-document',
  'related-to',
];

/** And between two highlights — the same sentence in two papers, said twice. */
export const ANNOTATION_TO_ANNOTATION_LINK_TYPES: readonly LinkType[] = [
  'annotation-references-annotation',
  'related-to',
];

/**
 * What can be said *to a claim* (`E02`): it bears it out, or it tells against it.
 *
 * Nothing else, and `related-to` is deliberately absent. A hypothesis is the one endpoint in
 * this app whose whole purpose is that the things pointing at it are weighed — the notebook
 * page draws them under *For* and *Against* — so an untyped edge to one would be a citation
 * that appears on neither line and counts for nothing. "I am not sure which side this is on"
 * is a real state, and the place for it is the claim's own status, not a third kind of edge.
 *
 * The vocabulary was already there and the librarian has been writing these since milestone 4
 * (`hypothesis:attachEvidence`). What was missing was only that `linkTypesFor` had no branch
 * for a hypothesis target, so the picker offered "related to" and the command — which
 * re-checks against this same function — would have refused anything better.
 */
export const DOCUMENT_TO_HYPOTHESIS_LINK_TYPES: readonly LinkType[] = [
  'document-supports-hypothesis',
  'document-opposes-hypothesis',
];

export const ANNOTATION_TO_HYPOTHESIS_LINK_TYPES: readonly LinkType[] = [
  'annotation-supports-hypothesis',
  'annotation-opposes-hypothesis',
];

/**
 * What may be asserted between a given pair of endpoints.
 *
 * One place, so the picker cannot offer a relationship the command would refuse and the
 * command cannot accept one the picker never showed. Pairs with nothing specific to say fall
 * back to `related-to` alone rather than to a longer list of near-misses.
 */
export function linkTypesFor(
  sourceType: LinkableEntityType,
  targetType: LinkableEntityType,
): readonly LinkType[] {
  if (sourceType === 'document' && targetType === 'document') return DOCUMENT_LINK_TYPES;
  if (sourceType === 'annotation' && targetType === 'document') {
    return ANNOTATION_TO_DOCUMENT_LINK_TYPES;
  }
  if (sourceType === 'annotation' && targetType === 'annotation') {
    return ANNOTATION_TO_ANNOTATION_LINK_TYPES;
  }
  if (targetType === 'hypothesis') {
    if (sourceType === 'document') return DOCUMENT_TO_HYPOTHESIS_LINK_TYPES;
    if (sourceType === 'annotation') return ANNOTATION_TO_HYPOTHESIS_LINK_TYPES;
    // A note or a day pointed at a claim has no `…-supports-hypothesis` type minted for it,
    // and inventing one here would put an edge in the table that the notebook page's two
    // lines cannot read. `related-to` says the honest thing: they are related, and nobody
    // has weighed it.
  }
  return [PLAIN_LINK];
}

/**
 * The edge a link nobody described carries (`H05`).
 *
 * "A link is just a link" is a statement about the *asking*, not about the table: every
 * relationship in this app is still a typed directed edge, and everything downstream — the
 * ledger's sentence, the graph's `data-link-type`, `link:findByType` — goes on reading one. So
 * a link made without a kind is written `related-to`, which is the honest name for what the
 * researcher said: these two belong together, and nobody weighed it further.
 */
export const PLAIN_LINK = 'related-to' satisfies LinkType;

/**
 * What to write between these two ends when the researcher was not asked.
 *
 * `null` for a pair that has no plain edge — which today is exactly a claim as the target. A
 * hypothesis is the one endpoint whose whole purpose is that what points at it is weighed: the
 * notebook page draws its evidence under *For* and *Against*, so an untyped edge to one would
 * appear on neither line and count for nothing. That is not a kind of link, it is which side
 * the evidence falls on, and it is the one thing the picker still asks (`E02`).
 */
export function defaultLinkType(
  sourceType: LinkableEntityType,
  targetType: LinkableEntityType,
): LinkType | null {
  return linkTypesFor(sourceType, targetType).includes(PLAIN_LINK) ? PLAIN_LINK : null;
}

/**
 * How a link type reads in a sentence, so a references row can say *how* two things are
 * related rather than only that they are.
 *
 * Unknown types fall back to their own id with the hyphens opened out: the type vocabulary is
 * deliberately open-ended, and a link the librarian invented should still be legible.
 */
const LINK_TYPE_LABELS: Readonly<Record<string, string>> = {
  'document-cites-document': 'cites',
  /**
   * The edge a `[[wikilink]]` derives, and in a markdown library the commonest edge there is.
   * Without a row here it fell to the fallback and every reference row read "document
   * references document" — and, incoming, "document references document this", which is not a
   * sentence. The type name is for the table; this is what it is called out loud.
   */
  'document-references-document': 'references',
  'note-references-document': 'references',
  'note-references-note': 'references',
  'note-references-annotation': 'references',
  'annotation-references-annotation': 'references',
  'annotation-references-document': 'bears on',
  'annotation-belongs-to-document': 'highlighted in',
  'excerpt-derived-from-annotation': 'excerpted from',
  'question-references-document': 'bears on',
  'question-references-annotation': 'bears on',
  'document-supports-hypothesis': 'supports',
  'document-opposes-hypothesis': 'opposes',
  'annotation-supports-hypothesis': 'supports',
  'annotation-opposes-hypothesis': 'opposes',
  'journal-entry-advances-question': 'advances',
  'child-of': 'part of',
  'related-to': 'related to',
};

export function linkTypeLabel(type: LinkType): string {
  return LINK_TYPE_LABELS[type] ?? type.split('-').join(' ');
}

/**
 * What a resolved link says beside the other end: the relationship, then where it lands.
 *
 * The direction is part of the relationship rather than decoration — "cites" and "cited by"
 * are different facts about the same edge — and the phrase is written from the point of view
 * of the entity that was asked about. The ledger and the references panel print the same
 * sentence and had a function each for it.
 */
export function describeResolvedLink(link: {
  readonly type: LinkType;
  readonly direction: 'incoming' | 'outgoing';
  readonly otherLocation: DocumentLocation | null;
}): string {
  const relationship =
    link.direction === 'outgoing' ? linkTypeLabel(link.type) : `${linkTypeLabel(link.type)} this`;
  const where = describeLocation(link.otherLocation);
  return where === '' ? relationship : `${relationship} · ${where}`;
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
