import { describe, expect, it } from 'vitest';
import type { AnnotationId, DocumentId, Link, LinkId, NoteId } from '@wr/shared-types';
import type { EntityRef } from '../src/entity-links.js';
import {
  hasParent,
  isParentLinkType,
  owningDocument,
  parentChain,
  resolveParent,
} from '../src/parent.js';

const DOC = 'doc_01j0000000000000000000000a' as DocumentId;
const ANN = 'ann_01j0000000000000000000000b' as AnnotationId;
const NOTE_PARENT = 'not_01j0000000000000000000000c' as NoteId;
const NOTE_CHILD = 'not_01j0000000000000000000000d' as NoteId;
const EXCERPT = 'exc_01j0000000000000000000000e';

const NOW = '2026-07-25T00:00:00.000Z';

function link(overrides: Partial<Link> & Pick<Link, 'id' | 'type' | 'sourceId' | 'targetId'>): Link {
  return {
    sourceType: 'annotation',
    targetType: 'document',
    sourceLocation: null,
    targetLocation: null,
    label: null,
    ordinal: null,
    origin: 'derived',
    generator: null,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Link;
}

/** A highlight on page 12 of a PDF, belonging to that document. */
const annotationBelongsToDocument = link({
  id: 'lnk_01j000000000000000000000a1' as LinkId,
  type: 'annotation-belongs-to-document',
  sourceId: ANN,
  sourceType: 'annotation',
  targetId: DOC,
  targetType: 'document',
  sourceLocation: { kind: 'pdf', pageIndex: 12 },
});

const excerptFromAnnotation = link({
  id: 'lnk_01j000000000000000000000a2' as LinkId,
  type: 'excerpt-derived-from-annotation',
  sourceId: EXCERPT,
  sourceType: 'excerpt',
  targetId: ANN,
  targetType: 'annotation',
});

const childNoteOfNote = link({
  id: 'lnk_01j000000000000000000000a3' as LinkId,
  type: 'child-of',
  sourceId: NOTE_CHILD,
  sourceType: 'note',
  targetId: NOTE_PARENT,
  targetType: 'note',
});

const annotationRef: EntityRef = { entityId: ANN, entityType: 'annotation', documentId: DOC };

describe('go to parent', () => {
  it('[L05] goes from an annotation to its parent document', () => {
    const resolved = resolveParent(annotationRef, [annotationBelongsToDocument]);

    expect(resolved).not.toBeNull();
    if (resolved === null) return;
    expect(resolved.parent.entityId).toBe(DOC);
    expect(resolved.parent.entityType).toBe('document');
    expect(resolved.relation).toBe('annotation-belongs-to-document');
    expect(resolved.via.id).toBe(annotationBelongsToDocument.id);
  });

  it('[L05] reveals the parent at the page the annotation sits on, not the top', () => {
    const resolved = resolveParent(annotationRef, [annotationBelongsToDocument]);
    expect(resolved?.location).toEqual({ kind: 'pdf', pageIndex: 12 });
    expect(resolved?.parent.location).toEqual({ kind: 'pdf', pageIndex: 12 });
  });

  it('[L05] returns null at the top of the chain', () => {
    const documentRef: EntityRef = { entityId: DOC, entityType: 'document', documentId: DOC };
    expect(resolveParent(documentRef, [annotationBelongsToDocument])).toBeNull();
    expect(hasParent(documentRef, [annotationBelongsToDocument])).toBe(false);
    expect(hasParent(annotationRef, [annotationBelongsToDocument])).toBe(true);
  });

  it('[L05] follows containment only in the child-to-parent direction', () => {
    // The document is the *target* of the edge; from the document, there is no parent.
    const fromDocument: EntityRef = { entityId: DOC, entityType: 'document' };
    expect(resolveParent(fromDocument, [annotationBelongsToDocument])).toBeNull();
  });

  it('[L05] ignores non-containment edges', () => {
    const reference = link({
      id: 'lnk_01j000000000000000000000a4' as LinkId,
      type: 'note-references-document',
      sourceId: NOTE_CHILD,
      sourceType: 'note',
      targetId: DOC,
      targetType: 'document',
    });

    expect(isParentLinkType('note-references-document')).toBe(false);
    expect(resolveParent({ entityId: NOTE_CHILD, entityType: 'note' }, [reference])).toBeNull();
  });

  it('[L05] resolves a child note to its parent note', () => {
    const resolved = resolveParent({ entityId: NOTE_CHILD, entityType: 'note' }, [childNoteOfNote]);
    expect(resolved?.parent.entityId).toBe(NOTE_PARENT);
    expect(resolved?.relation).toBe('child-of');
  });

  it('[L05] prefers the most specific containment when an entity has several', () => {
    const alsoChildOfNote = link({
      id: 'lnk_01j000000000000000000000a5' as LinkId,
      type: 'child-of',
      sourceId: EXCERPT,
      sourceType: 'excerpt',
      targetId: NOTE_PARENT,
      targetType: 'note',
    });

    const resolved = resolveParent({ entityId: EXCERPT, entityType: 'excerpt' }, [
      alsoChildOfNote,
      excerptFromAnnotation,
    ]);

    expect(resolved?.relation).toBe('excerpt-derived-from-annotation');
    expect(resolved?.parent.entityId).toBe(ANN);
  });

  it('[L05] walks upward on repeated invocation: excerpt to annotation to document', () => {
    const links = [excerptFromAnnotation, annotationBelongsToDocument];
    const chain = parentChain({ entityId: EXCERPT, entityType: 'excerpt' }, links);

    expect(chain.map((step) => step.parent.entityId)).toEqual([ANN, DOC]);
    expect(chain.map((step) => step.parent.entityType)).toEqual(['annotation', 'document']);
  });

  it('[L05] stops on a cycle rather than looping forever', () => {
    const cycleA = link({
      id: 'lnk_01j000000000000000000000b1' as LinkId,
      type: 'child-of',
      sourceId: NOTE_CHILD,
      sourceType: 'note',
      targetId: NOTE_PARENT,
      targetType: 'note',
    });
    const cycleB = link({
      id: 'lnk_01j000000000000000000000b2' as LinkId,
      type: 'child-of',
      sourceId: NOTE_PARENT,
      sourceType: 'note',
      targetId: NOTE_CHILD,
      targetType: 'note',
    });

    const chain = parentChain({ entityId: NOTE_CHILD, entityType: 'note' }, [cycleA, cycleB]);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.parent.entityId).toBe(NOTE_PARENT);
  });

  it('[L05] respects the depth limit', () => {
    const chain = parentChain({ entityId: EXCERPT, entityType: 'excerpt' }, [
      excerptFromAnnotation,
      annotationBelongsToDocument,
    ], 1);
    expect(chain).toHaveLength(1);
  });

  it('[L05] finds the document an excerpt ultimately lives in', () => {
    const links = [excerptFromAnnotation, annotationBelongsToDocument];
    expect(owningDocument({ entityId: EXCERPT, entityType: 'excerpt' }, links)?.entityId).toBe(DOC);
    expect(owningDocument(annotationRef, links)?.entityId).toBe(DOC);
    // A standalone note is not inside any document.
    expect(owningDocument({ entityId: NOTE_PARENT, entityType: 'note' }, links)).toBeNull();
  });
});
