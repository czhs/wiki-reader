/**
 * @wr/search — not yet implemented.
 *
 * Scheduled for milestone criterion M09: FTS5 chunking, query building, result mapping.
 * See docs/MILESTONE.md.
 *
 * This placeholder exists so the TypeScript project graph resolves. It throws rather than
 * returning a stub value: a silent no-op here would let a criterion appear to pass.
 */

export const PACKAGE_NAME = '@wr/search' as const;
export const IMPLEMENTED = false;

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`@wr/search: ${what} is not implemented yet (criterion M09)`);
    this.name = 'NotImplementedError';
  }
}
