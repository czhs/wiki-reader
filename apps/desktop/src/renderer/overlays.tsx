/**
 * The two surfaces that stand over the workspace: the command list, and the link picker.
 *
 * Both exist because the mechanism was already there and nothing pointed at it. The command
 * and keybinding registries have always known which chord runs what (`L09`), but the only way
 * to find an action was to already know its key — so `K03` is a *rendering* of the registry,
 * not a hand-written table of shortcuts that would drift the first time a binding moved. And
 * `links` has always held typed directed edges, but nothing in a reader could make one, so
 * `K01` is a gesture over `link:create` where both the other end and the relationship are
 * chosen by the researcher.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COMMAND_IDS,
  DOCUMENT_LINK_TYPES,
  linkTypeLabel,
  parseKeystroke,
  type Platform,
} from '@wr/workbench';
import type { LibraryItem } from '@wr/shared-types';
import { useWorkspace, useWorkspaceState } from './workspace.js';

/** Modifier glyphs, in the order macOS prints them. */
const MAC_MODIFIERS: readonly (readonly ['ctrl' | 'alt' | 'shift' | 'meta', string])[] = [
  ['ctrl', '⌃'],
  ['alt', '⌥'],
  ['shift', '⇧'],
  ['meta', '⌘'],
];

const KEY_NAMES: Readonly<Record<string, string>> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↩',
  escape: 'Esc',
  ' ': 'Space',
  '-': '−',
};

/**
 * A chord as a person reads it.
 *
 * The canonical form (`meta+shift+p`) is what the registry compares on and what the row keeps
 * in `data-chord`; this is what goes on screen. Two forms rather than one because a test that
 * asserted on `⇧⌘P` would be asserting about a font, and a user shown `meta+shift+p` would be
 * being told the key in a notation nothing on their keyboard uses.
 */
export function displayChord(chord: string, platform: Platform): string {
  const keystroke = parseKeystroke(chord);
  const key = KEY_NAMES[keystroke.key] ?? keystroke.key.toUpperCase();
  if (platform === 'mac') {
    const glyphs = MAC_MODIFIERS.filter(([flag]) => keystroke[flag]).map(([, glyph]) => glyph);
    return `${glyphs.join('')}${key}`;
  }
  const words: string[] = [];
  if (keystroke.ctrl) words.push('Ctrl');
  if (keystroke.alt) words.push('Alt');
  if (keystroke.shift) words.push('Shift');
  if (keystroke.meta) words.push('Meta');
  words.push(key);
  return words.join('+');
}

// ---------------------------------------------------------------------------
// The command list
// ---------------------------------------------------------------------------

/**
 * Every command, with the key that runs it (`K03`).
 *
 * The list is the registry, queried live — not a copy. That is the whole point: a binding
 * added to `DEFAULT_KEYBINDINGS` appears here without anyone remembering to also write it
 * down, and a binding that moved cannot be shown at its old chord.
 *
 * Disabled commands are shown greyed rather than hidden, as VS Code does. "Go Forward is a
 * thing this app can do, and it is not available right now" is information; an absence is
 * indistinguishable from the feature not existing.
 */
export function CommandList(): JSX.Element | null {
  const { store, workbench, run } = useWorkspace();
  const state = useWorkspaceState();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const open = state.commandsOpen;

  const close = useCallback(() => {
    store.update({ commandsOpen: false });
  }, [store]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [close, open]);

  // Re-queried on every render rather than memoized on `query`: a command's *enabled* state
  // depends on the context keys, which change under the palette while it is open.
  const results = open ? workbench.searchCommands(query) : [];
  const platform = workbench.keybindings.platform;

  if (!open) return null;

  return (
    <div className="wr-overlay" data-testid="command-list-overlay">
      <div
        className="wr-overlay__scrim"
        data-testid="command-list-scrim"
        role="presentation"
        onClick={close}
      />
      <div className="wr-palette" data-testid="command-list" role="dialog" aria-label="All commands">
        <input
          ref={inputRef}
          className="wr-palette__input"
          type="search"
          placeholder="Search every command…"
          aria-label="Search every command"
          data-testid="command-list-filter"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="wr-palette__list" data-testid="command-list-results">
          {results.length === 0 && (
            <p className="wr-palette__empty" data-testid="command-list-empty">
              No command matches “{query}”.
            </p>
          )}
          {results.map(({ command, enabled }) => {
            const chords = workbench.keybindings.chordsForCommand(command.id);
            return (
              <button
                key={command.id}
                type="button"
                className={
                  enabled ? 'wr-palette__row' : 'wr-palette__row wr-palette__row--disabled'
                }
                data-testid={`command-row-${command.id}`}
                data-command-id={command.id}
                // The canonical chords, for anything comparing against the registry.
                data-chord={chords.join(' ')}
                data-enabled={enabled ? 'true' : 'false'}
                onClick={() => {
                  close();
                  void run(command.id);
                }}
              >
                <span className="wr-palette__label">{command.label}</span>
                <span className="wr-palette__chords">
                  {chords.map((chord) => (
                    <kbd className="wr-kbd" key={chord}>
                      {displayChord(chord, platform)}
                    </kbd>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The link picker
// ---------------------------------------------------------------------------

/**
 * Linking the document being read to another one, with a relationship the researcher names.
 *
 * Both choices start empty and the button stays disabled until both are made. A preselected
 * relationship would be the criterion's "typed" reduced to decoration: every link anyone made
 * in a hurry would carry whichever type this file happened to list first, and afterwards it
 * would be indistinguishable from one they meant.
 */
export function LinkPicker(): JSX.Element | null {
  const { store, library, run } = useWorkspace();
  const state = useWorkspaceState();
  const sourceId = state.linkDraftSourceId;

  const [targetId, setTargetId] = useState<string | null>(null);
  const [linkType, setLinkType] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const close = useCallback(() => {
    store.update({ linkDraftSourceId: null });
  }, [store]);

  useEffect(() => {
    if (sourceId === null) {
      setTargetId(null);
      setLinkType(null);
      setFilter('');
    }
  }, [sourceId]);

  useEffect(() => {
    if (sourceId === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [close, sourceId]);

  const candidates = useMemo(() => {
    const everything: readonly LibraryItem[] = [...library.items, ...library.notes, ...library.added];
    const needle = filter.trim().toLowerCase();
    return everything
      .filter((item) => item.document.id !== sourceId)
      .filter((item) => needle === '' || item.document.title.toLowerCase().includes(needle));
  }, [filter, library.added, library.items, library.notes, sourceId]);

  if (sourceId === null) return null;

  const sourceTitle = state.documentTitles[sourceId] ?? 'this document';
  const ready = targetId !== null && linkType !== null;

  return (
    <div className="wr-overlay" data-testid="link-picker-overlay">
      <div
        className="wr-overlay__scrim"
        data-testid="link-picker-scrim"
        role="presentation"
        onClick={close}
      />
      <div className="wr-picker" data-testid="link-picker" role="dialog" aria-label="Link to another document">
        <h2 className="wr-picker__title" data-testid="link-picker-source">
          Link “{sourceTitle}” to
        </h2>

        <section className="wr-picker__section">
          <h3 className="wr-picker__heading">Which document?</h3>
          <input
            className="wr-picker__filter"
            type="search"
            placeholder="Filter the library…"
            aria-label="Filter the library"
            data-testid="link-picker-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="wr-picker__list" data-testid="link-picker-targets">
            {candidates.length === 0 && (
              <p className="wr-picker__empty" data-testid="link-picker-no-targets">
                Nothing else in the library to link to.
              </p>
            )}
            {candidates.map((item) => (
              <button
                key={item.document.id}
                type="button"
                className={
                  item.document.id === targetId
                    ? 'wr-picker__option wr-picker__option--chosen'
                    : 'wr-picker__option'
                }
                aria-pressed={item.document.id === targetId}
                data-testid={`link-picker-target-${item.document.id}`}
                onClick={() => setTargetId(item.document.id)}
              >
                {item.document.title}
              </button>
            ))}
          </div>
        </section>

        <section className="wr-picker__section">
          <h3 className="wr-picker__heading">What is the relationship?</h3>
          <div className="wr-picker__types" data-testid="link-picker-types">
            {DOCUMENT_LINK_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className={
                  type === linkType
                    ? 'wr-picker__type wr-picker__type--chosen'
                    : 'wr-picker__type'
                }
                aria-pressed={type === linkType}
                data-testid={`link-picker-type-${type}`}
                onClick={() => setLinkType(type)}
              >
                {linkTypeLabel(type)}
              </button>
            ))}
          </div>
        </section>

        <footer className="wr-picker__footer">
          <button type="button" className="wr-button" data-testid="link-picker-cancel" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="wr-button wr-button--primary"
            data-testid="link-picker-create"
            disabled={!ready}
            // The command writes the edge; this only collects the two choices. Which means
            // the same link can be made from a keybinding, a menu or a test without this
            // component being involved at all.
            onClick={() => {
              if (targetId === null || linkType === null) return;
              void run(COMMAND_IDS.createDocumentLink, { sourceId, targetId, linkType });
            }}
          >
            Create link
          </button>
        </footer>
      </div>
    </div>
  );
}
