/**
 * Which edges the researcher may take away, and which are not theirs (`H07`).
 *
 * The predicate is here rather than in the renderer or in main because both refuse on it: the
 * channel throws `CONFLICT` and every surface draws its × dead with the same sentence. Two
 * spellings would be a guard and a guess about the guard, and the guess is the one that drifts.
 */
import { describe, expect, it } from 'vitest';
import { unlinkRefusal } from './domain.js';

describe('unlinkRefusal', () => {
  it('[H07] lets a link the researcher made go', () => {
    expect(unlinkRefusal({ origin: 'manual', type: 'related-to' })).toBeNull();
    expect(unlinkRefusal({ origin: 'manual', type: 'question-references-document' })).toBeNull();
    // Including one whose *type* is the same as a generator's: what decides is who wrote it.
    expect(unlinkRefusal({ origin: 'manual', type: 'document-references-document' })).toBeNull();
    expect(unlinkRefusal({ origin: 'manual', type: 'annotation-belongs-to-document' })).toBeNull();
  });

  it('[H07] refuses a wikilink, which the next scan writes again', () => {
    const refusal = unlinkRefusal({ origin: 'derived', type: 'document-references-document' });
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('Edit the text');
  });

  it('[H07] refuses the edge a highlight has to its own file, which nothing writes again', () => {
    const refusal = unlinkRefusal({ origin: 'derived', type: 'annotation-belongs-to-document' });
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('marked sentence');
    // Two sentences, not one: the two are undone by opposite things — a scan, and nothing at
    // all — so a researcher told "edit the text" about a highlight would go looking for text.
    expect(refusal).not.toBe(
      unlinkRefusal({ origin: 'derived', type: 'document-references-document' }),
    );
  });
});
