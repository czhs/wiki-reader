/**
 * The application menu (criterion U01).
 *
 * This file exists for one reason: Electron's default macOS menu carries Window → Close on
 * `Cmd+W`, and a menu accelerator is handled *before* the renderer sees the keystroke. So the
 * workbench's own `wr.closeTab` binding never ran — the key was consumed by the menu, which
 * closed the window and took the app down with it. Removing that one item is what lets the
 * keystroke reach the workbench at all.
 *
 * Everything the default menu gives that a reader actually uses is kept. The edit roles in
 * particular: the note editor is a text surface, and undo, cut, copy, paste and select-all are
 * menu accelerators rather than anything the renderer implements.
 *
 * Reload and the zoom roles are deliberately absent. `Cmd+R` on a workspace that has an
 * unsaved layout in flight is a way to lose a session, and nothing in a local reader needs it.
 *
 * The template is a plain value so it can be asserted on without an Electron process; only
 * `index.ts` installs it.
 */
import type { MenuItemConstructorOptions } from 'electron';

export function applicationMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin';

  return [
    // Carries About, Services, Hide and Quit. No Close.
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    ...(isMac
      ? []
      : [{ label: 'File', submenu: [{ role: 'quit' }] } as MenuItemConstructorOptions]),
    { role: 'editMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
  ];
}

/**
 * Every accelerator the template asks for, flattened.
 *
 * Roles carry their accelerator implicitly — `close` *is* `Cmd+W` — so a check that only read
 * the explicit `accelerator` field would miss exactly the item this module was written to
 * remove. Both are reported.
 */
export function menuAccelerators(
  items: readonly MenuItemConstructorOptions[],
): readonly string[] {
  const found: string[] = [];
  for (const item of items) {
    if (typeof item.accelerator === 'string') found.push(item.accelerator);
    if (typeof item.role === 'string') found.push(`role:${item.role}`);
    if (Array.isArray(item.submenu)) {
      found.push(...menuAccelerators(item.submenu as readonly MenuItemConstructorOptions[]));
    }
  }
  return found;
}
