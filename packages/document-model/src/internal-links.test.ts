import { describe, expect, it } from 'vitest';
import { AnnotationIdSchema, DocumentIdSchema, NoteIdSchema } from '@wr/shared-types';
import {
  extractInternalLinks,
  formatInternalLink,
  internalLinkTarget,
  parseInternalLink,
} from './internal-links.js';
import { mintId } from './ids.js';

const documentId = DocumentIdSchema.parse(mintId('document'));
const annotationId = AnnotationIdSchema.parse(mintId('annotation'));
const noteId = NoteIdSchema.parse(mintId('note'));

describe('parseInternalLink', () => {
  it('[T09] parses each internal scheme', () => {
    expect(parseInternalLink(`document://${documentId}`)).toEqual({
      scheme: 'document',
      documentId,
    });
    expect(parseInternalLink(`annotation://${annotationId}`)).toEqual({
      scheme: 'annotation',
      annotationId,
    });
    expect(parseInternalLink(`note://${noteId}`)).toEqual({ scheme: 'note', noteId });
  });

  it('[T09] parses a location fragment into a typed DocumentLocation', () => {
    const link = `document://${documentId}#${encodeURIComponent(
      JSON.stringify({ kind: 'pdf', pageIndex: 11 }),
    )}`;
    const parsed = parseInternalLink(link);
    expect(parsed).toEqual({
      scheme: 'document',
      documentId,
      location: { kind: 'pdf', pageIndex: 11 },
    });
  });

  it('[T09] rejects unknown schemes', () => {
    expect(parseInternalLink(`https://example.com/${documentId}`)).toBeNull();
    expect(parseInternalLink(`collection://${documentId}`)).toBeNull();
  });

  it('[T09] rejects an ID whose prefix does not match the scheme', () => {
    expect(parseInternalLink(`document://${annotationId}`)).toBeNull();
    expect(parseInternalLink(`note://${documentId}`)).toBeNull();
  });

  it('[T09] rejects malformed IDs', () => {
    expect(parseInternalLink('document://not-an-id')).toBeNull();
    expect(parseInternalLink('document://doc_tooshort')).toBeNull();
    expect(parseInternalLink('document://')).toBeNull();
  });

  it('[T09] ignores an unparseable fragment rather than throwing', () => {
    const parsed = parseInternalLink(`document://${documentId}#not-json`);
    expect(parsed).toEqual({ scheme: 'document', documentId });
  });

  it('[T09] ignores a fragment that is JSON but not a valid location', () => {
    const link = `document://${documentId}#${encodeURIComponent('{"kind":"quantum"}')}`;
    expect(parseInternalLink(link)).toEqual({ scheme: 'document', documentId });
  });

  it('[T09] tolerates surrounding whitespace', () => {
    expect(parseInternalLink(`  note://${noteId}  `)).toEqual({ scheme: 'note', noteId });
  });
});

describe('formatInternalLink', () => {
  it('[T09] round-trips every scheme', () => {
    for (const link of [
      { scheme: 'document', documentId },
      { scheme: 'annotation', annotationId },
      { scheme: 'note', noteId },
    ] as const) {
      expect(parseInternalLink(formatInternalLink(link))).toEqual(link);
    }
  });

  it('[T09] round-trips a link carrying a location', () => {
    const link = {
      scheme: 'document',
      documentId,
      location: { kind: 'pdf', pageIndex: 7, pageOffsetRatio: 0.25 },
    } as const;
    expect(parseInternalLink(formatInternalLink(link))).toEqual(link);
  });
});

describe('extractInternalLinks', () => {
  it('[T09] finds every internal link embedded in prose', () => {
    const prose =
      `See document://${documentId} and also annotation://${annotationId}. ` +
      `Compare with https://example.com and note://${noteId}.`;
    const found = extractInternalLinks(prose);
    expect(found).toHaveLength(3);
    expect(found.map((l) => l.scheme)).toEqual(['document', 'annotation', 'note']);
  });

  it('[T09] skips malformed candidates without failing the whole scan', () => {
    const prose = `document://broken and note://${noteId}`;
    const found = extractInternalLinks(prose);
    expect(found).toHaveLength(1);
    expect(found[0]?.scheme).toBe('note');
  });

  it('[T09] returns an empty array when there is nothing to find', () => {
    expect(extractInternalLinks('plain prose with no links')).toEqual([]);
  });
});

describe('internalLinkTarget', () => {
  it('[T09] maps each scheme to its entity type and id', () => {
    expect(internalLinkTarget({ scheme: 'document', documentId })).toEqual({
      entityType: 'document',
      entityId: documentId,
    });
    expect(internalLinkTarget({ scheme: 'annotation', annotationId })).toEqual({
      entityType: 'annotation',
      entityId: annotationId,
    });
    expect(internalLinkTarget({ scheme: 'note', noteId })).toEqual({
      entityType: 'note',
      entityId: noteId,
    });
  });
});
