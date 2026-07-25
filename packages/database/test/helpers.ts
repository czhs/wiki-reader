import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedClock, openDatabase, type WikiReaderDatabase } from '../src/index.js';

/**
 * Each test gets its own directory and its own SQLite file, so tests never share state
 * and can run in any order or in parallel.
 */
export interface TempDatabase {
  readonly db: WikiReaderDatabase;
  readonly file: string;
  readonly dir: string;
  /** Close and reopen the same file — the persistence equivalent of restarting the app. */
  reopen(): WikiReaderDatabase;
  cleanup(): void;
}

export function createTempDatabase(name = 'wr-db'): TempDatabase {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const file = join(dir, 'wiki-reader.db');
  const clock = fixedClock('2026-01-01T00:00:00.000Z');
  let current = openDatabase({ file, clock }).db;

  return {
    get db() {
      return current;
    },
    file,
    dir,
    reopen(): WikiReaderDatabase {
      current.close();
      current = openDatabase({ file, clock: fixedClock('2026-06-01T00:00:00.000Z') }).db;
      return current;
    },
    cleanup(): void {
      try {
        current.close();
      } catch {
        // Already closed by the test; removing the directory is what matters.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A minimal PDF anchor for annotation tests. */
export function samplePdfAnchor(overrides: { pageIndex?: number; exact?: string } = {}) {
  const exact = overrides.exact ?? 'attention is all you need';
  return {
    kind: 'pdf' as const,
    version: 1 as const,
    pageIndex: overrides.pageIndex ?? 2,
    rects: [{ x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.24 }],
    quote: { exact, prefix: 'we show that ', suffix: ' for translation tasks' },
    position: { start: 120, end: 120 + exact.length },
    pageTextHash: 'fnv1a64:0123456789abcdef',
    contentHash: 'sha256:deadbeef',
  };
}
