/**
 * Pressing the chord the running app actually resolved for a command.
 *
 * Never a literal like `'Meta+Shift+G'`. A spec that types the key it remembers is asserting
 * about the key it remembers; these read `DEFAULT_KEYBINDINGS` — the same table the app
 * registered — and resolve the platform variant the suite is running on, so a binding that
 * moves takes its tests with it.
 *
 * Three specs had grown a copy of this, one of them having already merged the two halves into
 * a single function with the other name.
 */
import type { Page } from '@playwright/test';
import {
  DEFAULT_KEYBINDINGS,
  parseKeystroke,
  type KeybindingRule,
  type Keystroke,
} from '@wr/workbench';

/**
 * One rule's chord on the platform the suite is running on.
 *
 * `mac` is the override and `key` the fallback, which is the same reading `KeybindingRegistry`
 * does — and a spec that read only `key` would assert about a chord this machine never binds.
 */
export function chordOf(rule: KeybindingRule): Keystroke {
  return parseKeystroke(process.platform === 'darwin' ? (rule.mac ?? rule.key) : rule.key);
}

/** The chord the running app resolves for a command, on the platform the suite runs on. */
function chordFor(commandId: string): Keystroke {
  const rule = DEFAULT_KEYBINDINGS.find((candidate) => candidate.commandId === commandId);
  if (rule === undefined) throw new Error(`no default keybinding for ${commandId}`);
  return chordOf(rule);
}

/** That chord as Playwright spells one. */
function pressable(keystroke: Keystroke): string {
  const parts: string[] = [];
  if (keystroke.ctrl) parts.push('Control');
  if (keystroke.alt) parts.push('Alt');
  if (keystroke.shift) parts.push('Shift');
  if (keystroke.meta) parts.push('Meta');
  parts.push(keystroke.key);
  return parts.join('+');
}

/** A command's chord, straight to the string `keyboard.press` takes. */
function chordKeys(commandId: string): string {
  return pressable(chordFor(commandId));
}

/** Run a command the way the researcher would: by its key. */
export async function press(window: Page, commandId: string): Promise<void> {
  await window.keyboard.press(chordKeys(commandId));
}
