/**
 * @wr/database — not yet implemented.
 *
 * Scheduled for milestone criterion M03: SQLite migrations, repositories.
 * See docs/MILESTONE.md.
 *
 * This placeholder exists so the TypeScript project graph resolves. It throws rather than
 * returning a stub value: a silent no-op here would let a criterion appear to pass.
 */

export const PACKAGE_NAME = '@wr/database' as const;
export const IMPLEMENTED = false;

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`@wr/database: ${what} is not implemented yet (criterion M03)`);
    this.name = 'NotImplementedError';
  }
}
