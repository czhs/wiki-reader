/**
 * @wr/workbench — not yet implemented.
 *
 * Scheduled for milestone criterion M02: Dockview shell, command and keybinding registry.
 * See docs/MILESTONE.md.
 *
 * This placeholder exists so the TypeScript project graph resolves. It throws rather than
 * returning a stub value: a silent no-op here would let a criterion appear to pass.
 */

export const PACKAGE_NAME = '@wr/workbench' as const;
export const IMPLEMENTED = false;

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`@wr/workbench: ${what} is not implemented yet (criterion M02)`);
    this.name = 'NotImplementedError';
  }
}
