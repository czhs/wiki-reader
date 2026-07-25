import type { Database as SqliteDatabase } from 'better-sqlite3';
import { mintId } from '@wr/document-model';
import type { IndexingJob } from '@wr/shared-types';
import type { Clock } from '../clock.js';
import { toIndexingJob, type IndexingJobRow } from '../mappers.js';

export type JobType = IndexingJob['jobType'];

/**
 * The extraction and indexing queue.
 *
 * A partial unique index keeps at most one outstanding job per (document, type), so
 * enqueueing during a re-import cannot pile up duplicate extractions. Failures are
 * retained with their error text rather than being dropped: silent indexing failure is
 * the one bug that makes search quietly incomplete.
 */
export class IndexingJobsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  /** Queue a job, or return the outstanding one for the same document and type. */
  enqueue(documentId: string, jobType: JobType): { job: IndexingJob; created: boolean } {
    const pending = this.findPending(documentId, jobType);
    if (pending !== null) return { job: pending, created: false };

    const id = mintId('indexingJob');
    this.db
      .prepare(
        `INSERT INTO indexing_jobs
           (id, document_id, job_type, status, attempts, error, created_at, started_at, finished_at)
         VALUES (?, ?, ?, 'queued', 0, NULL, ?, NULL, NULL)`,
      )
      .run(id, documentId, jobType, this.clock.now());
    const job = this.getById(id);
    if (job === null) throw new Error('indexing_jobs.enqueue: row vanished after insert');
    return { job, created: true };
  }

  getById(id: string): IndexingJob | null {
    const row = this.db
      .prepare('SELECT * FROM indexing_jobs WHERE id = ?')
      .get(id) as IndexingJobRow | undefined;
    return row === undefined ? null : toIndexingJob(row);
  }

  findPending(documentId: string, jobType: JobType): IndexingJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM indexing_jobs
          WHERE document_id = ? AND job_type = ? AND status IN ('queued', 'running')`,
      )
      .get(documentId, jobType) as IndexingJobRow | undefined;
    return row === undefined ? null : toIndexingJob(row);
  }

  /** Atomically take the oldest queued job and mark it running. */
  claimNext(jobType?: JobType): IndexingJob | null {
    const claim = this.db.transaction((): IndexingJob | null => {
      const row = (
        jobType === undefined
          ? this.db
              .prepare(
                "SELECT * FROM indexing_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1",
              )
              .get()
          : this.db
              .prepare(
                `SELECT * FROM indexing_jobs WHERE status = 'queued' AND job_type = ?
                  ORDER BY created_at, id LIMIT 1`,
              )
              .get(jobType)
      ) as IndexingJobRow | undefined;
      if (row === undefined) return null;
      this.db
        .prepare(
          "UPDATE indexing_jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?",
        )
        .run(this.clock.now(), row.id);
      return this.getById(row.id);
    });
    return claim();
  }

  complete(id: string): void {
    this.db
      .prepare("UPDATE indexing_jobs SET status = 'complete', finished_at = ?, error = NULL WHERE id = ?")
      .run(this.clock.now(), id);
  }

  fail(id: string, error: string): void {
    this.db
      .prepare("UPDATE indexing_jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")
      .run(this.clock.now(), error, id);
  }

  /** Put a failed job back in the queue so a later run can retry it. */
  requeue(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE indexing_jobs SET status = 'queued', started_at = NULL, finished_at = NULL WHERE id = ? AND status = 'failed'",
        )
        .run(id).changes > 0
    );
  }

  counts(): { queued: number; running: number; complete: number; failed: number } {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM indexing_jobs GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    const counts = { queued: 0, running: 0, complete: 0, failed: 0 };
    for (const row of rows) {
      if (row.status === 'queued') counts.queued = row.n;
      else if (row.status === 'running') counts.running = row.n;
      else if (row.status === 'complete') counts.complete = row.n;
      else if (row.status === 'failed') counts.failed = row.n;
    }
    return counts;
  }

  listFailed(limit = 50): IndexingJob[] {
    const rows = this.db
      .prepare("SELECT * FROM indexing_jobs WHERE status = 'failed' ORDER BY finished_at DESC LIMIT ?")
      .all(limit) as IndexingJobRow[];
    return rows.map(toIndexingJob);
  }
}
