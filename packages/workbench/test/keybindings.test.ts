import { describe, expect, it } from 'vitest';
import { CommandRegistry } from '../src/commands.js';
import {
  formatKeystroke,
  KeybindingRegistry,
  KeybindingSyntaxError,
  keystrokeFromEvent,
  parseKeybindingsFile,
  parseKeystroke,
} from '../src/keybindings.js';

const NO_CONTEXT = {};

describe('keystroke parsing', () => {
  it('[L09] normalizes modifier spellings and key aliases', () => {
    expect(parseKeystroke('Shift+F12')).toEqual({
      key: 'f12',
      ctrl: false,
      shift: true,
      alt: false,
      meta: false,
    });
    // cmd, command, meta and super all mean the same modifier.
    for (const spelling of ['cmd+up', 'command+Up', 'meta+ARROWUP', 'super+up']) {
      expect(parseKeystroke(spelling)).toEqual({
        key: 'arrowup',
        ctrl: false,
        shift: false,
        alt: false,
        meta: true,
      });
    }
    expect(parseKeystroke('option+f12').alt).toBe(true);
    expect(parseKeystroke('control+minus')).toEqual({
      key: '-',
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
    });
  });

  it('[L09] round-trips through the canonical chord form', () => {
    for (const spec of ['ctrl+shift+p', 'shift+f12', 'cmd+up', 'alt+left', 'ctrl+minus']) {
      const parsed = parseKeystroke(spec);
      expect(parseKeystroke(formatKeystroke(parsed))).toEqual(parsed);
    }
    // Two spellings of one chord produce one canonical string.
    expect(formatKeystroke(parseKeystroke('Shift+Ctrl+P'))).toBe(
      formatKeystroke(parseKeystroke('ctrl+shift+p')),
    );
  });

  it('[L09] rejects malformed chords', () => {
    expect(() => parseKeystroke('')).toThrow(KeybindingSyntaxError);
    expect(() => parseKeystroke('ctrl')).toThrow(KeybindingSyntaxError);
    expect(() => parseKeystroke('a+b')).toThrow(KeybindingSyntaxError);
  });

  it('[L09] derives a keystroke from a keyboard event', () => {
    expect(
      keystrokeFromEvent({
        key: 'F12',
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        metaKey: false,
      }),
    ).toEqual({ key: 'f12', ctrl: false, shift: true, alt: false, meta: false });
  });
});

describe('KeybindingRegistry', () => {
  it('[L09] resolves a keystroke to its command', () => {
    const registry = new KeybindingRegistry('mac');
    registry.register({ commandId: 'wr.findAllReferences', key: 'shift+f12' });

    const match = registry.resolve(parseKeystroke('shift+f12'), NO_CONTEXT);
    expect(match?.commandId).toBe('wr.findAllReferences');
    expect(registry.resolve(parseKeystroke('f12'), NO_CONTEXT)).toBeNull();
  });

  it('[L09] applies the macOS override only on macOS', () => {
    const mac = new KeybindingRegistry('mac');
    mac.register({ commandId: 'wr.goToParent', key: 'ctrl+up', mac: 'cmd+up' });
    expect(mac.resolve(parseKeystroke('cmd+up'), NO_CONTEXT)?.commandId).toBe('wr.goToParent');
    expect(mac.resolve(parseKeystroke('ctrl+up'), NO_CONTEXT)).toBeNull();

    const win = new KeybindingRegistry('win');
    win.register({ commandId: 'wr.goToParent', key: 'ctrl+up', mac: 'cmd+up' });
    expect(win.resolve(parseKeystroke('ctrl+up'), NO_CONTEXT)?.commandId).toBe('wr.goToParent');
    expect(win.resolve(parseKeystroke('cmd+up'), NO_CONTEXT)).toBeNull();
  });

  it('[L09] honours the when clause so a key means different things in different panels', () => {
    const registry = new KeybindingRegistry('mac');
    registry.register({ commandId: 'wr.goToTarget', key: 'f12', when: 'linkUnderCursor' });

    expect(registry.resolve(parseKeystroke('f12'), { linkUnderCursor: true })?.commandId).toBe(
      'wr.goToTarget',
    );
    expect(registry.resolve(parseKeystroke('f12'), { linkUnderCursor: false })).toBeNull();
    expect(registry.resolve(parseKeystroke('f12'), NO_CONTEXT)).toBeNull();
  });

  it('[L09] prefers a user binding over the default for the same chord', () => {
    const registry = new KeybindingRegistry('mac');
    registry.register({ commandId: 'wr.defaultCommand', key: 'shift+f12', source: 'default' });
    registry.register({ commandId: 'wr.userCommand', key: 'shift+f12', source: 'user' });

    expect(registry.resolve(parseKeystroke('shift+f12'), NO_CONTEXT)?.commandId).toBe(
      'wr.userCommand',
    );
  });

  it('[L09] prefers the context-specific binding over the unconditional one', () => {
    const registry = new KeybindingRegistry('mac');
    registry.register({ commandId: 'wr.generic', key: 'f12' });
    registry.register({ commandId: 'wr.specific', key: 'f12', when: 'noteEditorFocus' });

    expect(registry.resolve(parseKeystroke('f12'), { noteEditorFocus: true })?.commandId).toBe(
      'wr.specific',
    );
    // Outside a note editor the specific binding does not apply, so the generic one runs.
    expect(registry.resolve(parseKeystroke('f12'), NO_CONTEXT)?.commandId).toBe('wr.generic');
  });

  it('[L09] respects explicit priority ahead of registration order', () => {
    const registry = new KeybindingRegistry('mac');
    registry.register({ commandId: 'wr.low', key: 'f4', priority: 1 });
    registry.register({ commandId: 'wr.high', key: 'f4', priority: 10 });
    registry.register({ commandId: 'wr.later', key: 'f4', priority: 1 });

    expect(registry.resolve(parseKeystroke('f4'), NO_CONTEXT)?.commandId).toBe('wr.high');
  });

  it('[L09] skips a binding whose command is disabled and falls through to the next', () => {
    const commands = new CommandRegistry();
    commands.register({
      id: 'wr.contextual',
      title: 'Contextual',
      category: 'Test',
      when: 'referencesPanelFocus',
      handler: () => null,
    });
    commands.register({
      id: 'wr.fallback',
      title: 'Fallback',
      category: 'Test',
      handler: () => null,
    });

    const registry = new KeybindingRegistry('mac');
    registry.register({ commandId: 'wr.fallback', key: 'f4', priority: 0 });
    registry.register({ commandId: 'wr.contextual', key: 'f4', priority: 5 });

    expect(registry.resolve(parseKeystroke('f4'), { referencesPanelFocus: true }, commands)?.commandId).toBe(
      'wr.contextual',
    );
    expect(registry.resolve(parseKeystroke('f4'), NO_CONTEXT, commands)?.commandId).toBe(
      'wr.fallback',
    );
  });

  it('[L09] skips a binding whose command was never registered', () => {
    const commands = new CommandRegistry();
    commands.register({ id: 'wr.real', title: 'Real', category: 'Test', handler: () => null });

    const registry = new KeybindingRegistry('mac');
    registry.register({ commandId: 'wr.real', key: 'f4', priority: 0 });
    registry.register({ commandId: 'wr.ghost', key: 'f4', priority: 9 });

    expect(registry.resolve(parseKeystroke('f4'), NO_CONTEXT, commands)?.commandId).toBe('wr.real');
  });

  it('[L09] carries command arguments through the binding', () => {
    const registry = new KeybindingRegistry('mac');
    registry.register({ commandId: 'wr.openDocument', key: 'f7', args: { mode: 'side' } });
    expect(registry.resolve(parseKeystroke('f7'), NO_CONTEXT)?.args).toEqual({ mode: 'side' });
  });

  it('[L09] unregisters via the returned disposer', () => {
    const registry = new KeybindingRegistry('mac');
    const dispose = registry.register({ commandId: 'wr.x', key: 'f9' });
    expect(registry.size).toBe(1);
    dispose();
    expect(registry.size).toBe(0);
    expect(registry.resolve(parseKeystroke('f9'), NO_CONTEXT)).toBeNull();
  });

  it('[L09] lists the chords bound to a command, for palette shortcut hints', () => {
    const registry = new KeybindingRegistry('mac');
    registry.register({ commandId: 'wr.openSearch', key: 'cmd+shift+f' });
    registry.register({ commandId: 'wr.openSearch', key: 'cmd+f' });
    expect(registry.chordsForCommand('wr.openSearch')).toEqual(['meta+f', 'shift+meta+f']);
    expect(registry.chordsForCommand('wr.unbound')).toEqual([]);
  });
});

describe('user keybindings file', () => {
  it('[L09] loads valid rules and marks them as user bindings', () => {
    const { rules, errors } = parseKeybindingsFile([
      { commandId: 'wr.goToTarget', key: 'ctrl+alt+g', when: 'linkUnderCursor' },
    ]);
    expect(errors).toEqual([]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.source).toBe('user');
  });

  it('[L09] skips one bad rule instead of discarding the whole file', () => {
    const { rules, errors } = parseKeybindingsFile([
      { commandId: 'wr.a', key: 'ctrl+a' },
      { commandId: 'wr.b', key: 'ctrl' },
      { commandId: 'wr.c', key: 'ctrl+c', when: 'linkUnderCursor &&' },
      { commandId: 'wr.d', key: 'ctrl+d' },
    ]);
    expect(rules.map((rule) => rule.commandId)).toEqual(['wr.a', 'wr.d']);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('wr.b');
    expect(errors[1]).toContain('wr.c');
  });

  it('[L09] rejects a file that is not an array of rules', () => {
    expect(parseKeybindingsFile({ nope: true }).errors).toHaveLength(1);
    expect(parseKeybindingsFile([{ key: 'ctrl+a' }]).rules).toEqual([]);
  });
});
