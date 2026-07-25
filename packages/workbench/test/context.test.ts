import { describe, expect, it, vi } from 'vitest';
import {
  ContextKeyService,
  evaluateWhen,
  parseWhen,
  tryParseWhen,
  unknownWhenKeys,
  whenKeys,
  WhenSyntaxError,
} from '../src/context.js';

describe('when expressions', () => {
  it('[L09] evaluates a bare context key by truthiness', () => {
    const expression = parseWhen('readerFocus');
    expect(evaluateWhen(expression, { readerFocus: true })).toBe(true);
    expect(evaluateWhen(expression, { readerFocus: false })).toBe(false);
    expect(evaluateWhen(expression, {})).toBe(false);
    expect(evaluateWhen(expression, { readerFocus: 'pdf' })).toBe(true);
    expect(evaluateWhen(expression, { readerFocus: '' })).toBe(false);
    expect(evaluateWhen(expression, { readerFocus: 0 })).toBe(false);
  });

  it('[L09] applies negation, conjunction and disjunction with correct precedence', () => {
    // `&&` binds tighter than `||`: a || (b && c)
    const expression = parseWhen('a || b && c');
    expect(evaluateWhen(expression, { a: true, b: false, c: false })).toBe(true);
    expect(evaluateWhen(expression, { a: false, b: true, c: true })).toBe(true);
    expect(evaluateWhen(expression, { a: false, b: true, c: false })).toBe(false);

    const parenthesised = parseWhen('(a || b) && c');
    expect(evaluateWhen(parenthesised, { a: true, b: false, c: false })).toBe(false);
    expect(evaluateWhen(parenthesised, { a: true, b: false, c: true })).toBe(true);

    expect(evaluateWhen(parseWhen('!textInputFocus'), { textInputFocus: true })).toBe(false);
    expect(evaluateWhen(parseWhen('!textInputFocus'), {})).toBe(true);
  });

  it('[L09] gates Go to Parent out of a text input, as the spec requires', () => {
    const expression = parseWhen('canGoToParent && !textInputFocus');
    expect(evaluateWhen(expression, { canGoToParent: true })).toBe(true);
    expect(evaluateWhen(expression, { canGoToParent: true, textInputFocus: true })).toBe(false);
    expect(evaluateWhen(expression, { canGoToParent: false })).toBe(false);
  });

  it('[L09] compares a context key against a literal', () => {
    const equals = parseWhen("activePanelKind == 'pdf-reader'");
    expect(evaluateWhen(equals, { activePanelKind: 'pdf-reader' })).toBe(true);
    expect(evaluateWhen(equals, { activePanelKind: 'note-editor' })).toBe(false);
    // An unset key equals nothing.
    expect(evaluateWhen(equals, {})).toBe(false);

    const notEquals = parseWhen("activePanelKind != 'note-editor'");
    expect(evaluateWhen(notEquals, { activePanelKind: 'pdf-reader' })).toBe(true);
    expect(evaluateWhen(notEquals, { activePanelKind: 'note-editor' })).toBe(false);
    expect(evaluateWhen(notEquals, {})).toBe(true);
  });

  it('[L09] rejects malformed expressions instead of silently disabling a key', () => {
    expect(() => parseWhen('a &&')).toThrow(WhenSyntaxError);
    expect(() => parseWhen('(a')).toThrow(WhenSyntaxError);
    expect(() => parseWhen('a b')).toThrow(WhenSyntaxError);
    expect(() => parseWhen('')).toThrow(WhenSyntaxError);
    expect(() => parseWhen('a & b')).toThrow(WhenSyntaxError);
    expect(() => parseWhen('a == ')).toThrow(WhenSyntaxError);
    expect(tryParseWhen('a &&')).toBeNull();
  });

  it('[L09] reports referenced keys and flags ones the workbench never sets', () => {
    const expression = parseWhen("readerFocus && !textInputFocus || activePanelKind == 'library'");
    expect(whenKeys(expression)).toEqual(['activePanelKind', 'readerFocus', 'textInputFocus']);
    expect(unknownWhenKeys(expression)).toEqual([]);
    expect(unknownWhenKeys(parseWhen('readerFocuss'))).toEqual(['readerFocuss']);
  });
});

describe('ContextKeyService', () => {
  it('[L09] notifies listeners only for keys whose value actually changed', () => {
    const context = new ContextKeyService();
    const listener = vi.fn();
    context.onDidChange(listener);

    context.set('readerFocus', true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[1]).toEqual(['readerFocus']);

    context.set('readerFocus', true);
    expect(listener).toHaveBeenCalledTimes(1);

    context.setMany({ readerFocus: false, textInputFocus: true });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]?.[1]).toEqual(['readerFocus', 'textInputFocus']);
  });

  it('[L09] removes keys and stops matching expressions that depend on them', () => {
    const context = new ContextKeyService();
    context.set('linkUnderCursor', true);
    expect(context.matches('linkUnderCursor')).toBe(true);

    context.setMany({ linkUnderCursor: undefined });
    expect(context.has('linkUnderCursor')).toBe(false);
    expect(context.matches('linkUnderCursor')).toBe(false);

    // An absent `when` means "always".
    expect(context.matches(undefined)).toBe(true);
    // A malformed `when` never matches, rather than matching everything.
    expect(context.matches('&&')).toBe(false);
  });

  it('[L09] unsubscribes cleanly', () => {
    const context = new ContextKeyService();
    const listener = vi.fn();
    const dispose = context.onDidChange(listener);
    dispose();
    context.set('readerFocus', true);
    expect(listener).not.toHaveBeenCalled();
  });
});
