/**
 * @wr/html-reader — not yet implemented.
 *
 * Scheduled for milestone criterion post-M14: Readability and sandboxed original view.
 * See docs/MILESTONE.md.
 *
 * This placeholder exists so the TypeScript project graph resolves. It throws rather than
 * returning a stub value: a silent no-op here would let a criterion appear to pass.
 */

export const PACKAGE_NAME = '@wr/html-reader' as const;
export const IMPLEMENTED = false;

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`@wr/html-reader: ${what} is not implemented yet (criterion post-M14)`);
    this.name = 'NotImplementedError';
  }
}
