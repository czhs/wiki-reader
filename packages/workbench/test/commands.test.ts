import { describe, expect, it, vi } from 'vitest';
import {
  CommandDisabledError,
  CommandNotFoundError,
  CommandRegistry,
  DuplicateCommandError,
} from '../src/commands.js';
import { WhenSyntaxError } from '../src/context.js';

function registryWith(...ids: string[]): CommandRegistry {
  const registry = new CommandRegistry();
  for (const id of ids) {
    registry.register({ id, title: id, category: 'Test', handler: () => id });
  }
  return registry;
}

describe('CommandRegistry', () => {
  it('[L09] dispatches a command by id and returns the handler result', async () => {
    const registry = new CommandRegistry();
    const handler = vi.fn(() => 'opened');
    registry.register({
      id: 'wr.openDocument',
      title: 'Open Document',
      category: 'Document',
      handler,
    });

    const result = await registry.execute('wr.openDocument', { documentId: 'doc_1' });

    expect(result).toBe('opened');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual({ documentId: 'doc_1' });
  });

  it('[L09] awaits asynchronous handlers', async () => {
    const registry = new CommandRegistry();
    registry.register({
      id: 'wr.slow',
      title: 'Slow',
      category: 'Test',
      handler: async () => {
        await Promise.resolve();
        return 42;
      },
    });
    await expect(registry.execute('wr.slow')).resolves.toBe(42);
  });

  it('[L09] throws for an unknown command rather than silently doing nothing', async () => {
    const registry = new CommandRegistry();
    await expect(registry.execute('wr.nope')).rejects.toBeInstanceOf(CommandNotFoundError);
  });

  it('[L09] refuses to register the same id twice', () => {
    const registry = registryWith('wr.a');
    expect(() =>
      registry.register({ id: 'wr.a', title: 'A again', category: 'Test', handler: () => null }),
    ).toThrow(DuplicateCommandError);
  });

  it('[L09] rejects a command whose when clause does not parse, at registration time', () => {
    const registry = new CommandRegistry();
    expect(() =>
      registry.register({
        id: 'wr.bad',
        title: 'Bad',
        category: 'Test',
        when: 'readerFocus &&',
        handler: () => null,
      }),
    ).toThrow(WhenSyntaxError);
    expect(registry.has('wr.bad')).toBe(false);
  });

  it('[L09] gates execution on the context expression', async () => {
    const registry = new CommandRegistry();
    const handler = vi.fn();
    registry.register({
      id: 'wr.goToParent',
      title: 'Go to Parent',
      category: 'Navigation',
      when: 'canGoToParent && !textInputFocus',
      handler,
    });

    expect(registry.isEnabled('wr.goToParent', { canGoToParent: true })).toBe(true);
    expect(
      registry.isEnabled('wr.goToParent', { canGoToParent: true, textInputFocus: true }),
    ).toBe(false);

    await expect(
      registry.execute('wr.goToParent', {}, { canGoToParent: true, textInputFocus: true }),
    ).rejects.toBeInstanceOf(CommandDisabledError);
    expect(handler).not.toHaveBeenCalled();

    await registry.execute('wr.goToParent', {}, { canGoToParent: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('[L09] passes the context snapshot through to the handler', async () => {
    const registry = new CommandRegistry();
    const handler = vi.fn();
    registry.register({ id: 'wr.x', title: 'X', category: 'Test', handler });
    await registry.execute('wr.x', { a: 1 }, { readerFocus: true });
    expect(handler.mock.calls[0]?.[1]).toEqual({ readerFocus: true });
  });

  it('[L09] unregisters via the returned disposer', async () => {
    const registry = new CommandRegistry();
    const dispose = registry.register({
      id: 'wr.temp',
      title: 'Temp',
      category: 'Test',
      handler: () => null,
    });
    expect(registry.has('wr.temp')).toBe(true);
    dispose();
    expect(registry.has('wr.temp')).toBe(false);
    await expect(registry.execute('wr.temp')).rejects.toBeInstanceOf(CommandNotFoundError);
  });

  it('[L09] disposing a re-registered id does not remove the replacement', () => {
    const registry = new CommandRegistry();
    const dispose = registry.register({
      id: 'wr.temp',
      title: 'First',
      category: 'Test',
      handler: () => 1,
    });
    dispose();
    registry.register({ id: 'wr.temp', title: 'Second', category: 'Test', handler: () => 2 });
    dispose();
    expect(registry.get('wr.temp')?.title).toBe('Second');
  });

  it('[L09] builds the palette label as "Category: Title"', () => {
    const registry = new CommandRegistry();
    registry.register({
      id: 'wr.findAllReferences',
      title: 'Find All References',
      category: 'Links',
      handler: () => null,
    });
    expect(registry.get('wr.findAllReferences')?.label).toBe('Links: Find All References');
  });
});

describe('command palette search', () => {
  function paletteRegistry(): CommandRegistry {
    const registry = new CommandRegistry();
    registry.registerAll([
      {
        id: 'wr.findAllReferences',
        title: 'Find All References',
        category: 'Links',
        keywords: ['backlinks', 'who links here'],
        handler: () => null,
      },
      {
        id: 'wr.goToParent',
        title: 'Go to Parent',
        category: 'Navigation',
        keywords: ['containing document'],
        when: 'canGoToParent',
        handler: () => null,
      },
      {
        id: 'wr.openToSide',
        title: 'Open to the Side',
        category: 'Document',
        handler: () => null,
      },
    ]);
    return registry;
  }

  it('[L09] finds commands by their technical name', () => {
    const results = paletteRegistry().search('find all references');
    expect(results[0]?.command.id).toBe('wr.findAllReferences');
  });

  it('[L09] finds commands by natural-language keyword', () => {
    const results = paletteRegistry().search('backlinks');
    expect(results[0]?.command.id).toBe('wr.findAllReferences');

    const bySynonym = paletteRegistry().search('containing document');
    expect(bySynonym[0]?.command.id).toBe('wr.goToParent');
  });

  it('[L09] matches on initials, VS Code style', () => {
    const results = paletteRegistry().search('far');
    expect(results.map((r) => r.command.id)).toContain('wr.findAllReferences');
  });

  it('[L09] lists disabled commands but flags them', () => {
    const results = paletteRegistry().search('parent', {});
    const parent = results.find((r) => r.command.id === 'wr.goToParent');
    expect(parent).toBeDefined();
    expect(parent?.enabled).toBe(false);

    const enabled = paletteRegistry().search('parent', { canGoToParent: true });
    expect(enabled.find((r) => r.command.id === 'wr.goToParent')?.enabled).toBe(true);
  });

  it('[L09] returns every command alphabetically for an empty query', () => {
    const results = paletteRegistry().search('');
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.command.label)).toEqual([
      'Document: Open to the Side',
      'Links: Find All References',
      'Navigation: Go to Parent',
    ]);
  });

  it('[L09] returns nothing for a query that matches nothing', () => {
    expect(paletteRegistry().search('zzzzqqq')).toEqual([]);
  });
});
