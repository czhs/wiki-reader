import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CHUNK_CHARS,
  chunkPdfPages,
  splitPageText,
  type ExtractedPage,
} from '../src/chunking.js';

/**
 * Chunking decides how precisely a search hit can be located, so these tests assert the two
 * properties the rest of the search stack depends on: every chunk's offsets address its own
 * text exactly, and no character of the page is dropped.
 */
describe('chunking', () => {
  function longPage(sentence: string, repetitions: number): string {
    return Array.from({ length: repetitions }, (_unused, index) => `${sentence} (${index}).`).join(
      ' ',
    );
  }

  it('[T07] returns no ranges for empty page text', () => {
    expect(splitPageText('')).toEqual([]);
  });

  it('[T07] keeps a page under the chunk limit as a single range covering all of it', () => {
    const text = 'Positional information enters the model through fixed sinusoidal encodings.';
    expect(splitPageText(text)).toEqual([{ start: 0, end: text.length }]);
  });

  it('[T07] splits a page past the limit into several ranges', () => {
    const text = longPage('The scaled dot-product operator divides the logits', 120);
    expect(text.length).toBeGreaterThan(DEFAULT_MAX_CHUNK_CHARS);

    const ranges = splitPageText(text);
    expect(ranges.length).toBeGreaterThan(1);
  });

  it('[T07] covers every character of the page across the ranges it produces', () => {
    const text = longPage('Residual connections wrap both sublayers', 150);
    const ranges = splitPageText(text);

    expect(ranges[0]?.start).toBe(0);
    expect(ranges.at(-1)?.end).toBe(text.length);
    // Consecutive ranges may overlap but must never leave a gap, or the text in the gap
    // would be stored yet unfindable.
    for (let index = 1; index < ranges.length; index += 1) {
      const previous = ranges[index - 1];
      const current = ranges[index];
      if (previous === undefined || current === undefined) throw new Error('missing range');
      expect(current.start).toBeLessThanOrEqual(previous.end);
      expect(current.end).toBeGreaterThan(current.start);
    }
  });

  it('[T07] overlaps consecutive ranges so a phrase across a split stays matchable', () => {
    const text = longPage('Label smoothing is applied throughout the schedule', 120);
    const ranges = splitPageText(text, { maxChunkChars: 500, overlapChars: 100 });

    expect(ranges.length).toBeGreaterThan(2);
    const second = ranges[1];
    const first = ranges[0];
    if (first === undefined || second === undefined) throw new Error('missing range');
    expect(second.start).toBeLessThan(first.end);
  });

  it('[T07] honours an explicit chunk size and never exceeds it', () => {
    const text = longPage('Beam search with a width of four outperforms greedy decoding', 80);
    const ranges = splitPageText(text, { maxChunkChars: 400, overlapChars: 40 });

    for (const range of ranges) {
      expect(range.end - range.start).toBeLessThanOrEqual(400);
    }
  });

  it('[T07] emits chunk rows whose offsets address their own text within the page', () => {
    const pages: ExtractedPage[] = [
      { pageIndex: 0, text: 'Attention mechanisms in sequence models.' },
      { pageIndex: 1, text: longPage('Each encoder layer applies multi-head attention', 120) },
    ];

    const chunks = chunkPdfPages(pages);
    expect(chunks.length).toBeGreaterThan(2);

    for (const chunk of chunks) {
      const page = pages[chunk.pageIndex ?? -1];
      if (page === undefined) throw new Error(`chunk points at missing page ${String(chunk.pageIndex)}`);
      expect(page.text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it('[T07] numbers chunks consecutively across page boundaries', () => {
    const pages: ExtractedPage[] = [
      { pageIndex: 0, text: longPage('First page body text', 120) },
      { pageIndex: 1, text: longPage('Second page body text', 120) },
    ];

    const chunks = chunkPdfPages(pages);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      chunks.map((_unused, index) => index),
    );
    expect(chunks.every((chunk) => chunk.kind === 'pdf-page')).toBe(true);
  });

  it('[T07] drops blank pages instead of indexing empty chunks', () => {
    const chunks = chunkPdfPages([
      { pageIndex: 0, text: 'Real text on the first page.' },
      { pageIndex: 1, text: '   \n  \n ' },
      { pageIndex: 2, text: '' },
      { pageIndex: 3, text: 'Real text on the last page.' },
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.pageIndex)).toEqual([0, 3]);
  });
});
