/**
 * @wr/pdf-reader — not yet implemented.
 *
 * Scheduled for milestone criterion M06: PDF.js reader and PdfDocumentAdapter.
 * See docs/MILESTONE.md.
 *
 * This placeholder exists so the TypeScript project graph resolves. It throws rather than
 * returning a stub value: a silent no-op here would let a criterion appear to pass.
 */

export const PACKAGE_NAME = '@wr/pdf-reader' as const;
export const IMPLEMENTED = false;

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`@wr/pdf-reader: ${what} is not implemented yet (criterion M06)`);
    this.name = 'NotImplementedError';
  }
}
