import type { DocumentId, DocumentLocation, Link } from '@wr/shared-types';
import type { EntityRef } from './entity-links.js';

/**
 * `goToParent` — walking up the containment chain.
 *
 * docs/SPEC.md lists the chain: an excerpt belongs to an annotation, an annotation belongs
 * to its document, a child note belongs to its parent note, a heading belongs to its
 * document. Repeated invocation keeps moving upward, so an embedded excerpt can walk out to
 * the annotation, the PDF page, and the document.
 *
 * Parents are read from the same typed edges as everything else rather than from a
 * dedicated column: a parent *is* a link, it just has a containment type.
 *
 * Criterion L05: a command goes from an annotation to its parent document.
 */

/**
 * Containment link types, most specific first. Order is the tie-break when an entity has
 * more than one candidate parent — an excerpt derived from an annotation that also sits in
 * a note should walk to the annotation, because that is the relationship it was born from.
 */
export const PARENT_LINK_TYPES = [
  'excerpt-derived-from-annotation',
  'annotation-belongs-to-document',
  'child-of',
] as const;

export type ParentLinkType = (typeof PARENT_LINK_TYPES)[number];

export function isParentLinkType(type: string): type is ParentLinkType {
  return (PARENT_LINK_TYPES as readonly string[]).includes(type);
}

export interface ParentResolution {
  readonly parent: EntityRef;
  /** The edge that established the relationship, for "why did it go there?". */
  readonly via: Link;
  readonly relation: ParentLinkType;
  /** Where to reveal the parent — an annotation's page, not the top of the document. */
  readonly location: DocumentLocation | null;
}

function rank(type: string): number {
  const index = (PARENT_LINK_TYPES as readonly string[]).indexOf(type);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Resolve the immediate semantic parent of an entity.
 *
 * `links` is the set of edges touching the entity; only outgoing containment edges count,
 * because containment points from child to parent. Returns `null` at the top of the chain.
 */
export function resolveParent(entity: EntityRef, links: readonly Link[]): ParentResolution | null {
  const candidates = links
    .filter((link) => link.sourceId === entity.entityId && isParentLinkType(link.type))
    .sort((a, b) => rank(a.type) - rank(b.type) || a.id.localeCompare(b.id));

  const via = candidates[0];
  if (via === undefined) return null;

  // Prefer where the child sits inside the parent (an annotation's page) over the parent's
  // own location, so going up reveals context rather than jumping to page one.
  const location = via.sourceLocation ?? via.targetLocation ?? entity.location ?? null;

  const base = { entityId: via.targetId, entityType: via.targetType };
  const located = location === null ? base : { ...base, location };
  // A document is its own `documentId`, which is what lets the reader open directly from
  // a parent resolution without a second lookup.
  const parent: EntityRef =
    via.targetType === 'document' ? { ...located, documentId: via.targetId as DocumentId } : located;

  return { parent, via, relation: via.type as ParentLinkType, location };
}

/** Whether `goToParent` would do anything — drives the `canGoToParent` context key. */
export function hasParent(entity: EntityRef, links: readonly Link[]): boolean {
  return resolveParent(entity, links) !== null;
}

/**
 * Walk the containment chain upward. Stops at the top, at `maxDepth`, or on a cycle —
 * link data is user-reachable, so a self-referential edge must not hang the UI.
 */
export function parentChain(
  entity: EntityRef,
  links: readonly Link[],
  maxDepth = 8,
): ParentResolution[] {
  const chain: ParentResolution[] = [];
  const visited = new Set<string>([entity.entityId]);
  let current = entity;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const resolved = resolveParent(current, links);
    if (resolved === null) break;
    if (visited.has(resolved.parent.entityId)) break;
    visited.add(resolved.parent.entityId);
    chain.push(resolved);
    current = resolved.parent;
  }

  return chain;
}

/**
 * The document an entity ultimately lives in, if any. Used to decide which reader to open
 * and to answer "reveal in library" for annotations, excerpts and headings alike.
 */
export function owningDocument(entity: EntityRef, links: readonly Link[]): EntityRef | null {
  if (entity.entityType === 'document') return entity;
  for (const step of parentChain(entity, links)) {
    if (step.parent.entityType === 'document') return step.parent;
  }
  return null;
}
