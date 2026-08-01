/**
 * The help page: what this app can do, and which key does it (criterion `D02`).
 *
 * Every word of the two lists below is read out of the command registry and the keybinding
 * registry as the running app holds them. Nothing here is a sheet someone typed: a sheet is a
 * second authority, and the first time a binding moved it would be a confidently wrong one —
 * which is the failure `K03` named for the command list and this page inherits at a larger
 * size. A command with no row is impossible, because the rows *are* `commands.all()`; a chord
 * printed at the wrong key is impossible, because the chords are `keybindings.all()`.
 *
 * It reads the registries rather than `DEFAULT_KEYBINDINGS` for the same reason. The default
 * table is only what the app shipped with; a user override loaded through
 * `loadUserKeybindings` is registered on top of it, and a page built from the table would be
 * describing keys that no longer do anything.
 *
 * The page is organised by *family* rather than alphabetically, because that is what the
 * scheme is (`D01`): the modifiers say what kind of thing is about to happen and the letter
 * says which one. The family is read off each binding — `DEFAULT_KEYBINDINGS` declares it —
 * so a rule added to a family joins its group here without this file being edited, and a
 * chord that keeps a convention its neighbours do not is filed where it belongs rather than
 * where its modifiers would put it.
 */
import { useMemo } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import type { Platform, RegisteredCommand, ResolvedKeybinding } from '@wr/workbench';
import { displayChord } from './overlays.js';
import { useWorkspace } from './workspace.js';

/** A binding that declares no family — a user's own — still gets a heading and a place. */
const UNNAMED_FAMILY = 'Your own keys';

/**
 * The context keys a person can be told about, held and denied.
 *
 * A binding's `when` clause is an expression over context keys — `canGoToParent &&
 * !textInputFocus` — which is exactly right for the resolver and is a debug dump on a page
 * meant for a researcher. This is the one place that turns it into a sentence, and it is
 * deliberately partial: a clause with a term that is not here, or that is not a plain
 * conjunction of terms, is printed as it stands. A wrong sentence about when a key works is
 * worse than a technical one.
 */
const CONDITIONS: Readonly<Record<string, readonly [held: string, denied: string]>> = {
  linkUnderCursor: ['the pointer is over a link', 'the pointer is not over a link'],
  textInputFocus: ['you are typing', 'you are not typing'],
  canGoToParent: [
    'what you are on is part of something',
    'what you are on is part of nothing else',
  ],
  canGoBack: ['there is somewhere to go back to', 'there is nowhere to go back to'],
  canGoForward: ['there is somewhere to go forward to', 'there is nowhere to go forward to'],
  documentSelected: ['a file is open', 'no file is open'],
  annotationSelected: ['a highlight is selected', 'no highlight is selected'],
};

function describeWhen(source: string): string {
  const terms = source.split('&&').map((term) => term.trim());
  const phrases: string[] = [];
  for (const term of terms) {
    const negated = term.startsWith('!');
    const key = (negated ? term.slice(1) : term).trim();
    const pair = CONDITIONS[key];
    if (pair === undefined) return source;
    phrases.push(negated ? pair[1] : pair[0]);
  }
  return phrases.join(', and ');
}

interface FamilyGroup {
  readonly title: string;
  readonly bindings: readonly ResolvedKeybinding[];
}

/**
 * The scheme, grouped the way it declares itself.
 *
 * The family is read off the binding rather than inferred from its modifiers, because the two
 * disagree exactly where it matters: `Cmd+Shift+W` closes a group and would otherwise be filed
 * under "go to a page" with every chord it shares modifiers with. Families come out in the
 * order their first binding was registered, which is the order the table declares them in.
 */
function groupByFamily(bindings: readonly ResolvedKeybinding[]): readonly FamilyGroup[] {
  const byFamily = new Map<string, ResolvedKeybinding[]>();
  for (const binding of bindings) {
    const title = binding.family ?? UNNAMED_FAMILY;
    const found = byFamily.get(title);
    if (found === undefined) byFamily.set(title, [binding]);
    else found.push(binding);
  }
  return [...byFamily.entries()].map(([title, list]) => ({ title, bindings: list }));
}

function groupByCategory(
  commands: readonly RegisteredCommand[],
): readonly { readonly category: string; readonly commands: readonly RegisteredCommand[] }[] {
  const byCategory = new Map<string, RegisteredCommand[]>();
  for (const command of commands) {
    const found = byCategory.get(command.category);
    if (found === undefined) byCategory.set(command.category, [command]);
    else found.push(command);
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, list]) => ({
      category,
      commands: [...list].sort((a, b) => a.title.localeCompare(b.title)),
    }));
}

function Chords({
  chords,
  platform,
}: {
  readonly chords: readonly string[];
  readonly platform: Platform;
}): JSX.Element {
  return (
    <span className="wr-help__chords">
      {chords.map((chord) => (
        <kbd className="wr-kbd" key={chord}>
          {displayChord(chord, platform)}
        </kbd>
      ))}
    </span>
  );
}

export function HelpPanelBody(): JSX.Element {
  const { workbench } = useWorkspace();
  const platform = workbench.keybindings.platform;

  // Read once per mount rather than memoised on the registries: neither has a change event,
  // and both are fixed for the life of the window unless a user file is loaded, which happens
  // before the first panel exists.
  const commands = useMemo(
    () => [...workbench.commands.all()].sort((a, b) => a.label.localeCompare(b.label)),
    [workbench],
  );
  const bindings = useMemo(() => workbench.keybindings.all(), [workbench]);
  const families = useMemo(() => groupByFamily(bindings), [bindings]);
  const categories = useMemo(() => groupByCategory(commands), [commands]);
  const onAKey = useMemo(
    () => new Set(bindings.map((binding) => binding.commandId)).size,
    [bindings],
  );

  return (
    <div
      className="wr-help"
      data-testid="help-panel"
      data-command-count={String(commands.length)}
      data-binding-count={String(bindings.length)}
    >
      <header className="wr-help__head">
        <h2 className="wr-help__title">What this app can do</h2>
        <p className="wr-help__blurb" data-testid="help-summary">
          {commands.length} things, {onAKey} of them on a key. This page is the command and
          keybinding registries themselves — if something is missing here, it is missing from the
          app.
        </p>
      </header>

      <section className="wr-help__section" data-testid="help-keyboard">
        <h3 className="wr-help__heading">The keyboard</h3>
        <p className="wr-help__family-blurb">
          The modifiers say what kind of thing is about to happen and the letter says which one.
          To reach a page, hold the page family’s modifiers and press the first letter of its
          name that is still free, reading from the left.
        </p>
        {families.map((family) => (
          <div
            className="wr-help__family"
            key={family.title}
            data-testid={`help-family-${family.title}`}
          >
            <h4 className="wr-help__family-title">{family.title}</h4>
            <ul className="wr-help__keys">
              {family.bindings.map((binding) => {
                const command = workbench.commands.get(binding.commandId);
                return (
                  <li
                    className="wr-help__key"
                    key={`${binding.chord}:${String(binding.ordinal)}`}
                    data-testid={`help-key-${binding.chord}`}
                    data-command-id={binding.commandId}
                    data-chord={binding.chord}
                  >
                    <Chords chords={[binding.chord]} platform={platform} />
                    <span className="wr-help__key-label">{command?.label ?? binding.commandId}</span>
                    {binding.when !== null && (
                      <span className="wr-help__when">
                        only when {describeWhen(binding.when.source)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      <section className="wr-help__section" data-testid="help-features">
        <h3 className="wr-help__heading">Everything, by what it is about</h3>
        {categories.map((group) => (
          <div
            className="wr-help__category"
            key={group.category}
            data-testid={`help-category-${group.category}`}
          >
            <h4 className="wr-help__family-title">{group.category}</h4>
            <ul className="wr-help__commands">
              {group.commands.map((command) => {
                const chords = workbench.keybindings.chordsForCommand(command.id);
                return (
                  <li
                    className="wr-help__command"
                    key={command.id}
                    data-testid={`help-command-${command.id}`}
                    data-command-id={command.id}
                    data-chord={chords.join(' ')}
                  >
                    <span className="wr-help__command-title">{command.title}</span>
                    {command.keywords.length > 0 && (
                      <span className="wr-help__keywords">{command.keywords.join(' · ')}</span>
                    )}
                    <Chords chords={chords} platform={platform} />
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

export function HelpPanel(_props: IDockviewPanelProps<{ panelId: string }>): JSX.Element {
  return <HelpPanelBody />;
}
