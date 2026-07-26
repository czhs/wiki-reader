/**
 * When the librarian runs.
 *
 * Roughly twice a day, and more often after a batch of imports. Deliberately **not**
 * event-triggered per document: the work is cumulative rather than a reaction to any one
 * arrival, and a run started by every import would produce a note about each new paper in
 * isolation, which is the opposite of what connections come from.
 *
 * A batch shortens the interval; it does not fire a pass by itself. That is the difference
 * between "there is materially more to read now" and "a file appeared".
 *
 * The decision is a pure function so it can be tested at any hour of any day. The timer
 * around it is a thin shell with no policy in it — which is the split that keeps a scheduling
 * bug from being reproducible only twice a day.
 */
import type { AgentRunRecord } from '@wr/database';
import type { Logger } from '../logger.js';

/** Twice a day. */
export const PASS_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** After a batch, this often instead. */
export const BATCH_INTERVAL_MS = 2 * 60 * 60 * 1000;
/** How many new documents make a batch. One paper is not a batch. */
export const BATCH_SIZE = 10;

export type ScheduleReason =
  | 'disabled'
  | 'already-running'
  | 'never-run'
  | 'interval-elapsed'
  | 'batch-imported'
  | 'not-due';

export interface ScheduleDecision {
  readonly due: boolean;
  readonly reason: ScheduleReason;
  readonly trigger: 'schedule' | 'import';
}

export interface ScheduleInput {
  readonly now: number;
  readonly enabled: boolean;
  readonly running: boolean;
  /** The most recent run, whatever its outcome. A failed pass still counts as an attempt. */
  readonly lastRun: Pick<AgentRunRecord, 'startedAt'> | null;
  /** Documents that arrived since that run started. */
  readonly importedSince: number;
}

export function decidePass(input: ScheduleInput): ScheduleDecision {
  if (!input.enabled) return { due: false, reason: 'disabled', trigger: 'schedule' };
  // One at a time. A second pass over a wiki the first is still reading would propose the
  // same connections twice and race it to the workspace.
  if (input.running) return { due: false, reason: 'already-running', trigger: 'schedule' };
  if (input.lastRun === null) return { due: true, reason: 'never-run', trigger: 'schedule' };

  const since = input.now - Date.parse(input.lastRun.startedAt);
  // An unparseable timestamp means the history cannot be trusted to say when the last pass
  // was, and refusing to run forever is the worse failure.
  if (Number.isNaN(since)) return { due: true, reason: 'never-run', trigger: 'schedule' };

  if (since >= PASS_INTERVAL_MS) {
    return { due: true, reason: 'interval-elapsed', trigger: 'schedule' };
  }
  if (input.importedSince >= BATCH_SIZE && since >= BATCH_INTERVAL_MS) {
    return { due: true, reason: 'batch-imported', trigger: 'import' };
  }
  return { due: false, reason: 'not-due', trigger: 'schedule' };
}

export interface LibrarianSchedulerOptions {
  readonly logger: Logger;
  /** Everything the decision needs, read fresh at each tick rather than captured. */
  readonly observe: () => ScheduleInput;
  readonly startPass: (trigger: 'schedule' | 'import') => Promise<unknown>;
  /** How often the decision is reconsidered. Not how often a pass runs. */
  readonly tickMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
}

/** The shell: a timer that asks `decidePass` and does what it says. */
export class LibrarianScheduler {
  readonly #logger: Logger;
  readonly #observe: () => ScheduleInput;
  readonly #startPass: (trigger: 'schedule' | 'import') => Promise<unknown>;
  readonly #tickMs: number;
  readonly #setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly #clearTimer: (timer: NodeJS.Timeout) => void;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: LibrarianSchedulerOptions) {
    this.#logger = options.logger.child('schedule');
    this.#observe = options.observe;
    this.#startPass = options.startPass;
    this.#tickMs = options.tickMs ?? 15 * 60 * 1000;
    this.#setTimer = options.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearInterval(timer));
  }

  start(): void {
    if (this.#timer !== null) return;
    const timer = this.#setTimer(() => void this.tick(), this.#tickMs);
    // A scheduling timer must never be the reason the app refuses to quit.
    if (typeof timer.unref === 'function') timer.unref();
    this.#timer = timer;
  }

  stop(): void {
    if (this.#timer === null) return;
    this.#clearTimer(this.#timer);
    this.#timer = null;
  }

  /** One consideration. Exported for the test, and for a manual "check now". */
  async tick(): Promise<ScheduleDecision> {
    const decision = decidePass(this.#observe());
    if (!decision.due) return decision;
    this.#logger.info('librarian pass due', { reason: decision.reason });
    try {
      await this.#startPass(decision.trigger);
    } catch (error) {
      this.#logger.error('scheduled pass failed', { reason: decision.reason, error });
    }
    return decision;
  }
}
