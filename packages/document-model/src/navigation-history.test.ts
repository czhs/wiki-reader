import { describe, expect, it } from 'vitest';
import type { NavigationLocation } from '@wr/shared-types';
import { DocumentIdSchema } from '@wr/shared-types';
import { NavigationHistory, isEquivalentLocation } from './navigation-history.js';
import { mintId } from './ids.js';

const docA = DocumentIdSchema.parse(mintId('document'));
const docB = DocumentIdSchema.parse(mintId('document'));

let clock = 0;
function at(documentId: string, pageIndex: number): NavigationLocation {
  clock += 1;
  return {
    entityId: documentId,
    entityType: 'document',
    documentId: DocumentIdSchema.parse(documentId),
    location: { kind: 'pdf', pageIndex },
    timestamp: clock,
  };
}

describe('NavigationHistory', () => {
  it('[L06] starts empty and permits neither direction', () => {
    const history = new NavigationHistory();
    expect(history.size).toBe(0);
    expect(history.current).toBeNull();
    expect(history.canGoBack).toBe(false);
    expect(history.canGoForward).toBe(false);
    expect(history.back()).toBeNull();
    expect(history.forward()).toBeNull();
  });

  it('[L06] moves back and forward through recorded locations', () => {
    const history = new NavigationHistory();
    history.push(at(docA, 1));
    history.push(at(docA, 5));
    history.push(at(docB, 2));

    expect(history.canGoForward).toBe(false);
    expect(history.canGoBack).toBe(true);

    expect(history.back()?.location).toEqual({ kind: 'pdf', pageIndex: 5 });
    expect(history.back()?.location).toEqual({ kind: 'pdf', pageIndex: 1 });
    expect(history.canGoBack).toBe(false);

    expect(history.forward()?.location).toEqual({ kind: 'pdf', pageIndex: 5 });
    expect(history.forward()?.location).toEqual({ kind: 'pdf', pageIndex: 2 });
    expect(history.canGoForward).toBe(false);
  });

  it('[L06] truncates the forward stack when navigating somewhere new', () => {
    const history = new NavigationHistory();
    history.push(at(docA, 1));
    history.push(at(docA, 2));
    history.push(at(docA, 3));
    history.back();
    history.back();

    history.push(at(docB, 9));

    expect(history.canGoForward).toBe(false);
    expect(history.size).toBe(2);
    expect(history.current?.documentId).toBe(docB);
  });

  it('[L06] collapses repeated pushes to an equivalent location', () => {
    const history = new NavigationHistory();
    history.push(at(docA, 3));
    const created = history.push(at(docA, 3));

    expect(created).toBe(false);
    expect(history.size).toBe(1);
  });

  it('[L06] treats a different page of the same document as a distinct entry', () => {
    const history = new NavigationHistory();
    history.push(at(docA, 3));
    expect(history.push(at(docA, 4))).toBe(true);
    expect(history.size).toBe(2);
  });

  it('[L06] evicts the oldest entries beyond the limit', () => {
    const history = new NavigationHistory(3);
    for (let page = 1; page <= 5; page += 1) history.push(at(docA, page));

    expect(history.size).toBe(3);
    expect(history.entries()[0]?.location).toEqual({ kind: 'pdf', pageIndex: 3 });
    expect(history.current?.location).toEqual({ kind: 'pdf', pageIndex: 5 });
  });

  it('[L06] rejects a nonsensical limit', () => {
    expect(() => new NavigationHistory(0)).toThrow(RangeError);
  });

  it('[L06] round-trips through JSON preserving the cursor', () => {
    const history = new NavigationHistory();
    history.push(at(docA, 1));
    history.push(at(docA, 2));
    history.push(at(docB, 3));
    history.back();

    const restored = NavigationHistory.fromJSON(history.toJSON());

    expect(restored.size).toBe(3);
    expect(restored.cursor).toBe(history.cursor);
    expect(restored.current).toEqual(history.current);
    expect(restored.canGoForward).toBe(true);
    expect(restored.forward()?.documentId).toBe(docB);
  });

  it('[L06] clamps an out-of-range cursor when restoring', () => {
    const restored = NavigationHistory.fromJSON({ entries: [at(docA, 1)], cursor: 99 });
    expect(restored.cursor).toBe(0);
    expect(restored.canGoForward).toBe(false);
  });
});

describe('isEquivalentLocation', () => {
  it('[L06] distinguishes different entities', () => {
    expect(isEquivalentLocation(at(docA, 1), at(docB, 1))).toBe(false);
  });

  it('[L06] treats different note blocks as distinct', () => {
    const base: NavigationLocation = {
      entityId: 'not_0123456789abcdefghjkmnpq',
      entityType: 'note',
      location: { kind: 'note', blockIndex: 1 },
      timestamp: 1,
    };
    const other: NavigationLocation = {
      ...base,
      location: { kind: 'note', blockIndex: 2 },
    };
    expect(isEquivalentLocation(base, other)).toBe(false);
  });
});
