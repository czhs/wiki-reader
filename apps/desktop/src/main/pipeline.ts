/**
 * Extraction and indexing pipeline (criterion M09).
 *
 * A document becomes searchable through a durable job queue rather than an in-memory
 * promise chain: importing a library can queue hundreds of PDFs, and a crash partway
 * through must not leave a document permanently un-indexed with no record of why. Jobs live
 * in `indexing_jobs`, are claimed one at a time, and are marked complete or failed with the
 * error text attached.
 *
 * This module is deliberately free of Electron imports so the whole pipeline can be
 * exercised under vitest against a real SQLite file and a real PDF.
 */
import { readFile } from 'node:fs/promises';
import type { WikiReaderDatabase } from '@wr/database';
import { SearchIndexer } from '@wr/search';
import { extractPdfText, type ExtractedPage } from '@wr/text-extraction-worker';
import type { Logger } from './logger.js';
import { resolveAllowedPath, type AllowedRoots } from './paths.js';

export interface PipelineProgress {
  readonly documentId: string;
  readonly stage: 'extract' | 'chunk' | 'index' | 'done' | 'error';
  readonly processed: number;
  readonly total: number;
  readonly message?: string;
}

/** Injectable so tests can drive the pipeline without a PDF parser. */
export type PdfExtractor = (data: Uint8Array) => Promise<{ pages: readonly ExtractedPage[] }>;

export interface PipelineOptions {
  readonly logger: Logger;
  readonly allowed: AllowedRoots;
  readonly onProgress?: (progress: PipelineProgress) => void;
  readonly extractPdf?: PdfExtractor;
  readonly readFileBytes?: (path: string) => Promise<Buffer>;
}

export interface DrainResult {
  readonly processed: number;
  readonly succeeded: number;
  readonly failed: number;
}

/**
 * Runs extraction jobs to completion.
 *
 * `drain` is serial by design. PDF parsing is CPU-bound and memory-hungry; running twenty
 * concurrently during a large import is how the main process gets killed by the OS.
 */
export class ExtractionPipeline {
  private readonly indexer: SearchIndexer;
  private readonly logger: Logger;
  private readonly allowed: AllowedRoots;
  private readonly onProgress: (progress: PipelineProgress) => void;
  private readonly extractPdf: PdfExtractor;
  private readonly readFileBytes: (path: string) => Promise<Buffer>;
  private running: Promise<DrainResult> | null = null;

  constructor(
    private readonly db: WikiReaderDatabase,
    options: PipelineOptions,
  ) {
    this.logger = options.logger.child('pipeline');
    this.allowed = options.allowed;
    this.onProgress = options.onProgress ?? ((): void => undefined);
    this.extractPdf = options.extractPdf ?? ((data): Promise<{ pages: readonly ExtractedPage[] }> => extractPdfText(data));
    this.readFileBytes = options.readFileBytes ?? ((path): Promise<Buffer> => readFile(path));
    this.indexer = new SearchIndexer(db, {
      info: (message, fields) => this.logger.info(message, fields),
      warn: (message, fields) => this.logger.warn(message, fields),
    });
  }

  /** Queue a document for text extraction. Idempotent: a pending job is reused. */
  enqueue(documentId: string): boolean {
    const { created } = this.db.jobs.enqueue(documentId, 'extract-text');
    this.logger.info('extraction queued', { documentId, created });
    return created;
  }

  /**
   * Drain the queue.
   *
   * Concurrent callers join the in-flight drain instead of starting a second one — two
   * drains would race to claim the same job and double-index it.
   */
  async drain(): Promise<DrainResult> {
    if (this.running !== null) return this.running;
    this.running = this.drainOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drainOnce(): Promise<DrainResult> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (;;) {
      const job = this.db.jobs.claimNext('extract-text');
      if (job === null) break;
      processed += 1;

      try {
        await this.runExtraction(job.documentId);
        this.db.jobs.complete(job.id);
        succeeded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.jobs.fail(job.id, message);
        failed += 1;
        this.logger.error('extraction failed', { documentId: job.documentId, jobId: job.id, error });
        this.onProgress({ documentId: job.documentId, stage: 'error', processed: 0, total: 0, message });
      }
    }

    // Re-projection jobs, queued when a removed document is restored. Drained here rather than
    // in their own runner because they are the cheap half of the same queue: no file is read
    // and no text is parsed, so a document whose chunks already exist becomes findable again
    // without waiting behind an extraction. A queue with no consumer is worse than no queue —
    // it reports work as pending forever, and reads as "this was handled".
    for (;;) {
      const job = this.db.jobs.claimNext('index-fts');
      if (job === null) break;
      processed += 1;

      try {
        const entries = this.indexer.reindexDocument(job.documentId);
        this.db.jobs.complete(job.id);
        succeeded += 1;
        this.onProgress({ documentId: job.documentId, stage: 'done', processed: entries, total: entries });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.jobs.fail(job.id, message);
        failed += 1;
        this.logger.error('reindex failed', { documentId: job.documentId, jobId: job.id, error });
        this.onProgress({ documentId: job.documentId, stage: 'error', processed: 0, total: 0, message });
      }
    }

    if (processed > 0) this.logger.info('drained extraction queue', { processed, succeeded, failed });
    return { processed, succeeded, failed };
  }

  /**
   * Extract one document's text and index it.
   *
   * Every failure mode here is reported rather than swallowed, because each one looks
   * identical from the UI — a document that simply never appears in search results.
   */
  async runExtraction(documentId: string): Promise<void> {
    const file = this.db.files.primaryForDocument(documentId);
    if (file === null) throw new Error(`document ${documentId} has no primary file`);
    if (file.mimeType !== 'application/pdf') {
      throw new Error(`unsupported mime type for extraction: ${file.mimeType}`);
    }
    // Resolved through symlinks: the extractor reads these bytes, so a link inside an allowed
    // root must not be able to feed it a file from outside one.
    const resolved = await resolveAllowedPath(file.path, this.allowed);
    if (!resolved.ok) {
      // A missing file and an escape attempt are different failures, and the job row is the
      // only place either becomes visible — reporting one as the other sends the reader
      // looking for a permissions problem that does not exist.
      throw new Error(
        resolved.reason === 'outside-roots'
          ? `file path is outside the allowed roots: ${file.id}`
          : `file is unreadable on disk: ${resolved.cause}`,
      );
    }

    this.onProgress({ documentId, stage: 'extract', processed: 0, total: 1 });
    const bytes = await this.readFileBytes(resolved.path);
    const { pages } = await this.extractPdf(new Uint8Array(bytes));

    // The revision is what anchors and chunks hang off. Creating it here (rather than at
    // import time) keeps the content hash and the extracted text describing the same bytes.
    const { revision } = this.db.revisions.createIfChanged({
      documentId,
      contentHash: file.contentHash,
    });
    this.db.files.setRevision(file.id, revision.id);

    this.onProgress({ documentId, stage: 'index', processed: pages.length, total: pages.length });
    const result = this.indexer.indexExtractedPdf(documentId, revision.id, pages);

    this.logger.info('document indexed', {
      documentId,
      revisionId: revision.id,
      pages: pages.length,
      chunks: result.chunkCount,
      entries: result.entryCount,
    });
    this.onProgress({ documentId, stage: 'done', processed: pages.length, total: pages.length });
  }
}
