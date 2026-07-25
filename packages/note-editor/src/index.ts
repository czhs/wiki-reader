/**
 * @wr/note-editor — not yet implemented.
 *
 * Scheduled for milestone criterion M13: Tiptap editor and internal-link nodes.
 * See docs/MILESTONE.md.
 *
 * This placeholder exists so the TypeScript project graph resolves. It throws rather than
 * returning a stub value: a silent no-op here would let a criterion appear to pass.
 */

export const PACKAGE_NAME = '@wr/note-editor' as const;
export const IMPLEMENTED = false;

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`@wr/note-editor: ${what} is not implemented yet (criterion M13)`);
    this.name = 'NotImplementedError';
  }
}
