/**
 * Injectable clock.
 *
 * Repositories never call `Date.now()` directly: tests need deterministic, ordered
 * timestamps, and a fake clock is the only way to assert on `updatedAt` without sleeping.
 */
export interface Clock {
  now(): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

/** A clock that advances by a fixed step on every read. For tests. */
export function fixedClock(start: string, stepMs = 1000): Clock {
  let current = Date.parse(start);
  if (Number.isNaN(current)) throw new TypeError(`fixedClock: invalid start ${start}`);
  return {
    now(): string {
      const value = new Date(current).toISOString();
      current += stepMs;
      return value;
    },
  };
}
