/**
 * @wr/indexing-worker — not yet implemented.
 *
 * Scheduled for milestone criterion M09: FTS5 indexing job runner.
 * See docs/MILESTONE.md.
 *
 * This placeholder exists so the TypeScript project graph resolves. It throws rather than
 * returning a stub value: a silent no-op here would let a criterion appear to pass.
 */

export const PACKAGE_NAME = '@wr/indexing-worker' as const;
export const IMPLEMENTED = false;

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`@wr/indexing-worker: ${what} is not implemented yet (criterion M09)`);
    this.name = 'NotImplementedError';
  }
}
