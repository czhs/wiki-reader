/**
 * @wr/zotero-adapter — not yet implemented.
 *
 * Scheduled for milestone criterion M04: Zotero local API client and mapping.
 * See docs/MILESTONE.md.
 *
 * This placeholder exists so the TypeScript project graph resolves. It throws rather than
 * returning a stub value: a silent no-op here would let a criterion appear to pass.
 */

export const PACKAGE_NAME = '@wr/zotero-adapter' as const;
export const IMPLEMENTED = false;

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`@wr/zotero-adapter: ${what} is not implemented yet (criterion M04)`);
    this.name = 'NotImplementedError';
  }
}
