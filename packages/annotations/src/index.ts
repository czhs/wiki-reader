/**
 * @wr/annotations — not yet implemented.
 *
 * Scheduled for milestone criterion M11: Annotation panels and anchor resolution UI.
 * See docs/MILESTONE.md.
 *
 * This placeholder exists so the TypeScript project graph resolves. It throws rather than
 * returning a stub value: a silent no-op here would let a criterion appear to pass.
 */

export const PACKAGE_NAME = '@wr/annotations' as const;
export const IMPLEMENTED = false;

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`@wr/annotations: ${what} is not implemented yet (criterion M11)`);
    this.name = 'NotImplementedError';
  }
}
