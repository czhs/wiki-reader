import { describe, expect, it } from 'vitest';
import { parseInternalLink } from '@wr/document-model';
import type { AnnotationId, DocumentId, Link, NoteId } from '@wr/shared-types';
import {
  canonicalLinkType,
  createLinkDraft,
  derivedLinksFromNote,
  diffDerivedLinks,
  entityRefFromInternalLink,
  internalLinkFor,
  otherEndpoint,
  UnsupportedLinkError,
  type EntityRef,
} from '../src/entity-links.js';

const DOC_A = 'doc_01j0000000000000000000000a' as DocumentId;
const DOC_B = 'doc_01j0000000000000000000000b' as DocumentId;
const NOTE_A = 'not_01j0000000000000000000000c' as NoteId;
const NOTE_B = 'not_01j0000000000000000000000d' as NoteId;
const ANN_A = 'ann_01j0000000000000000000000e' as AnnotationId;

const NOW = '2026-07-25T00:00:00.000Z';

const noteRef: EntityRef = { entityId: NOTE_A, entityType: 'note' };
const docRef: EntityRef = { entityId: DOC_A, entityType: 'document', documentId: DOC_A };
const annRef: EntityRef = { entityId: ANN_A, entityType: 'annotation', documentId: DOC_A };

describe('typed links between notes, annotations and documents', () => {
  it('[L01] derives the canonical link type from the endpoint types', () => {
    expect(canonicalLinkType('note', 'document')).toBe('note-references-document');
    expect(canonicalLinkType('note', 'note')).toBe('note-references-note');
    expect(canonicalLinkType('note', 'annotation')).toBe('note-references-annotation');
    expect(canonicalLinkType('annotation', 'document')).toBe('annotation-belongs-to-document');
    expect(canonicalLinkType('annotation', 'annotation')).toBe('annotation-references-annotation');
    expect(canonicalLinkType('document', 'document')).toBe('document-cites-document');
    expect(canonicalLinkType('excerpt', 'annotation')).toBe('excerpt-derived-from-annotation');
    expect(canonicalLinkType('document', 'note')).toBeNull();
  });

  it('[L01] creates a directed, typed edge with both endpoints recorded', () => {
    const link = createLinkDraft({ source: noteRef, target: docRef, now: NOW });

    expect(link.type).toBe('note-references-document');
    expect(link.sourceId).toBe(NOTE_A);
    expect(link.sourceType).toBe('note');
    expect(link.targetId).toBe(DOC_A);
    expect(link.targetType).toBe('document');
    expect(link.origin).toBe('manual');
    expect(link.createdAt).toBe(NOW);
    expect(link.updatedAt).toBe(NOW);
    expect(link.id).toMatch(/^lnk_[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it('[L01] preserves the precise location of each endpoint', () => {
    const link = createLinkDraft({
      source: { ...noteRef, location: { kind: 'note', blockIndex: 3 } },
      target: { ...docRef, location: { kind: 'pdf', pageIndex: 11 } },
      label: 'see the ablation table',
      now: NOW,
    });

    expect(link.sourceLocation).toEqual({ kind: 'note', blockIndex: 3 });
    expect(link.targetLocation).toEqual({ kind: 'pdf', pageIndex: 11 });
    expect(link.label).toBe('see the ablation table');
  });

  it('[L01] refuses to invent a type for a pair with no canonical relationship', () => {
    expect(() =>
      createLinkDraft({ source: docRef, target: noteRef, now: NOW }),
    ).toThrow(UnsupportedLinkError);

    // An explicit type is always allowed.
    const explicit = createLinkDraft({
      source: docRef,
      target: noteRef,
      type: 'related-to',
      now: NOW,
    });
    expect(explicit.type).toBe('related-to');
  });

  it('[L01] mints a distinct id per link', () => {
    const a = createLinkDraft({ source: noteRef, target: docRef, now: NOW });
    const b = createLinkDraft({ source: noteRef, target: docRef, now: NOW });
    expect(a.id).not.toBe(b.id);
  });

  it('[L01] resolves the far endpoint and the direction of a link', () => {
    const link = createLinkDraft({ source: noteRef, target: annRef, now: NOW });

    const fromNote = otherEndpoint(link, NOTE_A);
    expect(fromNote.entityId).toBe(ANN_A);
    expect(fromNote.direction).toBe('outgoing');

    const fromAnnotation = otherEndpoint(link, ANN_A);
    expect(fromAnnotation.entityId).toBe(NOTE_A);
    expect(fromAnnotation.direction).toBe('incoming');
  });
});

describe('internal link round-trip', () => {
  it('[L01] renders each entity type as its internal link scheme', () => {
    expect(internalLinkFor(docRef)).toBe(`document://${DOC_A}`);
    expect(internalLinkFor(annRef)).toBe(`annotation://${ANN_A}`);
    expect(internalLinkFor(noteRef)).toBe(`note://${NOTE_A}`);
    // Chunks are addressed through their document, so they have no link form of their own.
    expect(internalLinkFor({ entityId: 'chk_x', entityType: 'chunk' })).toBeNull();
  });

  it('[L01] carries a location through the link and back', () => {
    const link = internalLinkFor({ ...docRef, location: { kind: 'pdf', pageIndex: 9 } });
    expect(link).not.toBeNull();

    const parsed = parseInternalLink(link ?? '');
    expect(parsed).not.toBeNull();
    if (parsed === null) return;

    const ref = entityRefFromInternalLink(parsed);
    expect(ref.entityId).toBe(DOC_A);
    expect(ref.entityType).toBe('document');
    expect(ref.location).toEqual({ kind: 'pdf', pageIndex: 9 });
  });
});

describe('links derived from note content', () => {
  const content = [
    'Compare the setup in document://' + DOC_A + ' against the follow-up.',
    'The highlight annotation://' + ANN_A + ' makes the point directly,',
    'and my earlier note://' + NOTE_B + ' has the derivation.',
  ].join('\n');

  it('[L01] derives one typed link per referenced entity', () => {
    const links = derivedLinksFromNote({ noteId: NOTE_A, content, now: NOW });

    expect(links).toHaveLength(3);
    expect(links.map((link) => link.type).sort()).toEqual([
      'note-references-annotation',
      'note-references-document',
      'note-references-note',
    ]);
    for (const link of links) {
      expect(link.sourceId).toBe(NOTE_A);
      expect(link.origin).toBe('derived');
      expect(link.generator).toBe('note-content-scanner');
    }
  });

  it('[L01] collapses repeated mentions of the same entity into one edge', () => {
    const repeated = `see document://${DOC_A} and again document://${DOC_A}`;
    const links = derivedLinksFromNote({ noteId: NOTE_A, content: repeated, now: NOW });
    expect(links).toHaveLength(1);
  });

  it('[L01] ignores a note that references itself', () => {
    const links = derivedLinksFromNote({
      noteId: NOTE_A,
      content: `this is note://${NOTE_A}`,
      now: NOW,
    });
    expect(links).toEqual([]);
  });

  it('[L01] ignores malformed link-looking text', () => {
    const links = derivedLinksFromNote({
      noteId: NOTE_A,
      content: 'document://not-an-id and http://example.com/document://doc_x',
      now: NOW,
    });
    expect(links).toEqual([]);
  });

  it('[L01] finds nothing in a note with no references', () => {
    expect(
      derivedLinksFromNote({ noteId: NOTE_A, content: 'plain prose, no links', now: NOW }),
    ).toEqual([]);
  });

  it('[L01] reconciles an edit as inserts and deletes, keeping unchanged edges', () => {
    const before = derivedLinksFromNote({
      noteId: NOTE_A,
      content: `document://${DOC_A} and note://${NOTE_B}`,
      now: NOW,
    });
    const after = derivedLinksFromNote({
      noteId: NOTE_A,
      content: `document://${DOC_A} and document://${DOC_B}`,
      now: '2026-07-26T00:00:00.000Z',
    });

    const { toInsert, toDelete } = diffDerivedLinks(before, after);

    expect(toInsert.map((link) => link.targetId)).toEqual([DOC_B]);
    expect(toDelete.map((link) => link.targetId)).toEqual([NOTE_B]);

    // The unchanged mention keeps its original link row, and therefore its creation time.
    const unchanged: readonly Link[] = before.filter((link) => link.targetId === DOC_A);
    expect(toDelete).not.toContain(unchanged[0]);
  });

  it('[L01] treats an unedited note as requiring no writes at all', () => {
    const links = derivedLinksFromNote({ noteId: NOTE_A, content, now: NOW });
    const again = derivedLinksFromNote({ noteId: NOTE_A, content, now: NOW });
    const { toInsert, toDelete } = diffDerivedLinks(links, again);
    expect(toInsert).toEqual([]);
    expect(toDelete).toEqual([]);
  });
});
