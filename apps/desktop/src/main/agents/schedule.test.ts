/**
 * When the librarian runs (criterion A13, first half).
 *
 * The decision is a pure function, which is what makes these cases assertable at all: a
 * scheduling rule tested through a real timer is a rule you can only see fail twice a day.
 * `now` and the last run are arguments, so every boundary is reachable directly.
 *
 * The rule with judgement in it is the batch one. "More often after a batch of imports" must
 * not collapse into "run on every import" — the work is cumulative, and a pass per arriving
 * paper produces a note about each one in isolation, which is the opposite of a connection.
 */
import { describe, expect, it } from 'vitest';
import {
  BATCH_INTERVAL_MS,
  BATCH_SIZE,
  LibrarianScheduler,
  PASS_INTERVAL_MS,
  decidePass,
} from './schedule.js';
import { silentLogger } from '../logger.js';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const at = (msAgo: number): { startedAt: string } => ({
  startedAt: new Date(NOW - msAgo).toISOString(),
});

const base = {
  now: NOW,
  enabled: true,
  running: false,
  lastRun: null,
  importedSince: 0,
} as const;

describe('when the librarian runs', () => {
  it('[A13] runs roughly twice a day', () => {
    expect(PASS_INTERVAL_MS).toBe(12 * 60 * 60 * 1000);

    expect(decidePass({ ...base, lastRun: at(PASS_INTERVAL_MS - 1000) }).due).toBe(false);
    expect(decidePass({ ...base, lastRun: at(PASS_INTERVAL_MS) })).toMatchObject({
      due: true,
      reason: 'interval-elapsed',
    });
  });

  it('[A13] runs the first time it is ever asked', () => {
    expect(decidePass({ ...base, lastRun: null })).toMatchObject({
      due: true,
      reason: 'never-run',
    });
  });

  it('[A13] runs sooner after a batch of imports, but not because of any one of them', () => {
    const recently = at(BATCH_INTERVAL_MS + 1000);

    // One paper is not a batch, and nine are not either. The pass is cumulative work, not a
    // reaction to a document arriving.
    expect(decidePass({ ...base, lastRun: recently, importedSince: 1 }).due).toBe(false);
    expect(decidePass({ ...base, lastRun: recently, importedSince: BATCH_SIZE - 1 }).due).toBe(
      false,
    );

    expect(decidePass({ ...base, lastRun: recently, importedSince: BATCH_SIZE })).toMatchObject({
      due: true,
      reason: 'batch-imported',
      trigger: 'import',
    });
  });

  it('[A13] will not start a second pass on top of a batch that just ran', () => {
    // A batch shortens the interval; it does not remove it. Otherwise an import during a
    // pass would queue another the moment the first finished.
    expect(
      decidePass({ ...base, lastRun: at(60_000), importedSince: BATCH_SIZE * 10 }).due,
    ).toBe(false);
  });

  it('[A13] runs one pass at a time, and none at all when agents are off', () => {
    expect(decidePass({ ...base, running: true })).toMatchObject({
      due: false,
      reason: 'already-running',
    });
    expect(decidePass({ ...base, enabled: false })).toMatchObject({
      due: false,
      reason: 'disabled',
    });
    // Off outranks everything, including a wiki that has never been read.
    expect(decidePass({ ...base, enabled: false, lastRun: null }).due).toBe(false);
  });

  it('[A13] runs rather than stalling forever when the history is unreadable', () => {
    expect(decidePass({ ...base, lastRun: { startedAt: 'not a timestamp' } }).due).toBe(true);
  });

  it('[A13] the timer starts a pass when the decision says it is due, and not otherwise', async () => {
    const started: string[] = [];
    let due = false;

    const scheduler = new LibrarianScheduler({
      logger: silentLogger,
      // Read fresh at each tick: a scheduler that captured this would go on believing what
      // was true when it was constructed.
      observe: () => ({ ...base, lastRun: due ? null : at(0) }),
      startPass: async (trigger) => {
        started.push(trigger);
      },
    });

    await scheduler.tick();
    expect(started).toEqual([]);

    due = true;
    await scheduler.tick();
    expect(started).toEqual(['schedule']);
  });

  it('[A13] keeps ticking after a pass throws', async () => {
    let attempts = 0;
    const scheduler = new LibrarianScheduler({
      logger: silentLogger,
      observe: () => ({ ...base, lastRun: null }),
      startPass: async () => {
        attempts += 1;
        throw new Error('claude is not installed');
      },
    });

    await expect(scheduler.tick()).resolves.toMatchObject({ due: true });
    await expect(scheduler.tick()).resolves.toMatchObject({ due: true });
    expect(attempts).toBe(2);
  });
});
