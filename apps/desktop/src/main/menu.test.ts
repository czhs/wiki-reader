/**
 * The application menu (criterion U01).
 *
 * The E2E half of `U01` presses Cmd+W through CDP, which delivers straight to the renderer and
 * so cannot see a menu accelerator at all. On a real machine the menu is the *first* thing the
 * keystroke meets, and Electron's default one closes the window with it. That half is asserted
 * here, on the template, which is why the template is a plain value.
 */
import { describe, expect, it } from 'vitest';
import { applicationMenuTemplate, menuAccelerators } from './menu.js';

describe('the application menu', () => {
  it('[U01] gives no menu item the keystroke that closes a tab', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const accelerators = menuAccelerators(applicationMenuTemplate(platform));
      expect(accelerators, `${platform} keeps a window-closing role`).not.toContain('role:close');
      for (const accelerator of accelerators) {
        expect(accelerator.toLowerCase(), `${platform} binds ${accelerator}`).not.toMatch(
          /(cmdorctrl|cmd|command|ctrl)\+w$/u,
        );
      }
    }
  });

  it('[U01] keeps the editing accelerators the note editor depends on', () => {
    // Undo, cut, copy, paste and select-all are menu accelerators, not renderer behaviour.
    // Dropping the whole menu to solve Cmd+W would have taken all of them out with it.
    expect(menuAccelerators(applicationMenuTemplate('darwin'))).toContain('role:editMenu');
  });

  it('[P12] leaves Cmd+S to the renderer, so it saves the page being written', () => {
    // The other half of `P12`, and it can only be asserted here: the E2E presses the chord
    // through CDP, which delivers straight to the renderer and cannot see a menu accelerator
    // at all. On a real machine the menu meets the keystroke first — so a File menu that grew
    // a Save item, or a role that carries `Cmd+S`, would take the key away from the notebook
    // page on the researcher's machine while every test still passed.
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const accelerators = menuAccelerators(applicationMenuTemplate(platform));
      expect(accelerators, `${platform} keeps a saving role`).not.toContain('role:save');
      for (const accelerator of accelerators) {
        expect(accelerator.toLowerCase(), `${platform} binds ${accelerator}`).not.toMatch(
          /(cmdorctrl|cmd|command|ctrl)\+s$/u,
        );
      }
    }
  });

  it('[U01] can still be quit, on every platform', () => {
    // macOS gets Quit from the app menu; elsewhere it needs its own item, and a menu with no
    // way out at all would be a worse bug than the one being fixed.
    expect(menuAccelerators(applicationMenuTemplate('darwin'))).toContain('role:appMenu');
    for (const platform of ['win32', 'linux'] as const) {
      expect(menuAccelerators(applicationMenuTemplate(platform))).toContain('role:quit');
    }
  });
});
