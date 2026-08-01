import { describe, expect, it } from 'vitest';
import type { AnnotationAnchor, ResolvedLocation } from '@wr/shared-types';
import { describeAnchorHealth } from './anchor-health.js';

/** A markdown anchor, because markdown is one of the readers that reports nothing back. */
const anchor: AnnotationAnchor = {
  kind: 'markdown',
  version: 1,
  quote: { exact: 'Recall is strongest when review is spread out', prefix: '', suffix: '' },
  position: { start: 0, end: 45 },
  documentTextHash: 'text-hash',
  sourceHash: 'source-hash',
  normalizationVersion: 1,
};

const found = (strategy: ResolvedLocation['strategy']): ResolvedLocation => ({
  location: { kind: 'markdown', textRange: { start: 0, end: 45 } },
  strategy,
  confidence: 1,
});

describe('describeAnchorHealth', () => {
  it('reports an anchor found where it was made as anchored', () => {
    expect(describeAnchorHealth(anchor, found('exact-position')).state).toBe('ok');
  });

  it('reports an anchor re-found by its quote as relocated', () => {
    expect(describeAnchorHealth(anchor, found('quote-relocated')).state).toBe('moved');
  });

  it('reports a reader that looked and did not find it as broken', () => {
    expect(describeAnchorHealth(anchor, null).state).toBe('broken');
  });

  /**
   * The distinction the badge exists for. Only the PDF reader publishes resolutions today, so
   * every highlight made on markdown or on a saved web page arrives here with nothing
   * recorded. Reading that as failure struck through a highlight the researcher could see on
   * the page in front of them, which is the fastest way to teach someone to ignore a warning.
   */
  it('reports an anchor nothing has resolved as unknown, not broken', () => {
    expect(describeAnchorHealth(anchor, undefined).state).toBe('unknown');
  });
});
