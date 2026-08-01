import { z } from 'zod';
import { evaluateWhen, parseWhen, type ContextSnapshot, type WhenExpression } from './context.js';
import type { CommandArgs, CommandRegistry } from './commands.js';

/**
 * The keybinding registry.
 *
 * Components never attach their own key listeners. One resolver owns the keyboard: it maps
 * a keystroke plus the current context to a command id. That is what lets F12 mean "go to
 * target" in a reader and nothing at all inside a text input, and it is the precondition
 * for the user-editable keybindings JSON that docs/SPEC.md defers past milestone 1 but
 * requires the registry to support now.
 *
 * Resolution order, highest first: user bindings before defaults, then explicit priority,
 * then a binding with a `when` clause before an unconditional one (more specific wins),
 * then later registration. A binding whose command is disabled by context is skipped so a
 * lower-priority binding for the same key still gets its chance.
 */

export type Platform = 'mac' | 'win' | 'linux';
export type KeybindingSource = 'default' | 'user';

export interface Keystroke {
  /** Normalized, lowercase, e.g. `f12`, `arrowup`, `minus`, `p`. */
  readonly key: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export interface KeybindingRule {
  readonly commandId: string;
  /** Default chord, e.g. `"shift+f12"`. */
  readonly key: string;
  /** macOS override, e.g. `"cmd+up"` where other platforms use `"ctrl+up"`. */
  readonly mac?: string;
  readonly when?: string;
  readonly priority?: number;
  readonly args?: CommandArgs;
  readonly source?: KeybindingSource;
  /**
   * Which family of the scheme this binding belongs to, e.g. `"Go to a page"`.
   *
   * A label, not behaviour: nothing resolves differently because of it. It is here because the
   * help page has to say what a modifier *means* (`D01`, `D02`), and the only two places that
   * could answer are the table that decides the scheme and a sheet written beside it — and a
   * sheet is exactly what the criterion forbids. Deriving it from the modifiers instead would
   * be wrong the moment one binding keeps a convention its neighbours do not: `Cmd+Shift+W`
   * closes a group and is no part of the family the rest of `Cmd+Shift` forms.
   */
  readonly family?: string;
}

export interface ResolvedKeybinding {
  readonly commandId: string;
  readonly keystroke: Keystroke;
  /** Canonical chord string, e.g. `"shift+f12"`. */
  readonly chord: string;
  readonly when: WhenExpression | null;
  readonly priority: number;
  readonly args: CommandArgs | undefined;
  readonly source: KeybindingSource;
  /** The family label the rule declared, or `null` for a binding that names none. */
  readonly family: string | null;
  /** Registration ordinal; breaks ties so the later binding wins. */
  readonly ordinal: number;
}

export class KeybindingSyntaxError extends Error {
  readonly spec: string;
  constructor(message: string, spec: string) {
    super(`${message} (in keybinding \`${spec}\`)`);
    this.name = 'KeybindingSyntaxError';
    this.spec = spec;
  }
}

// ---------------------------------------------------------------------------
// Keystroke parsing and normalization
// ---------------------------------------------------------------------------

const MODIFIER_ALIASES: Readonly<Record<string, 'ctrl' | 'shift' | 'alt' | 'meta'>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
};

/**
 * Names for keys that are punctuation or otherwise awkward to write in a chord.
 * The values match `KeyboardEvent.key` lowercased, so `keystrokeFromEvent` and
 * `parseKeystroke` meet in the middle.
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  space: ' ',
  minus: '-',
  plus: '+',
  equals: '=',
  comma: ',',
  period: '.',
  slash: '/',
  backslash: '\\',
  backtick: '`',
  pageup: 'pageup',
  pagedown: 'pagedown',
};

/** Inverse of `KEY_ALIASES` for the few keys we prefer to print by name. */
const KEY_DISPLAY: Readonly<Record<string, string>> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  '-': 'minus',
  ' ': 'space',
};

function normalizeKeyName(raw: string): string {
  const lower = raw.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/** Parse a chord such as `"ctrl+shift+p"` into a normalized keystroke. */
export function parseKeystroke(spec: string): Keystroke {
  const trimmed = spec.trim();
  if (trimmed.length === 0) throw new KeybindingSyntaxError('empty keybinding', spec);

  // Split on `+` but keep a literal trailing `+` (as in `ctrl++`) as the key itself.
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i] ?? '';
    if (char === '+' && current.length > 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.length > 0) parts.push(current);

  let ctrl = false;
  let shift = false;
  let alt = false;
  let meta = false;
  let key: string | null = null;

  for (const part of parts) {
    const token = part.trim().toLowerCase();
    if (token.length === 0) continue;
    const modifier = MODIFIER_ALIASES[token];
    if (modifier !== undefined) {
      if (modifier === 'ctrl') ctrl = true;
      else if (modifier === 'shift') shift = true;
      else if (modifier === 'alt') alt = true;
      else meta = true;
      continue;
    }
    if (key !== null) {
      throw new KeybindingSyntaxError(`more than one non-modifier key (\`${key}\`, \`${token}\`)`, spec);
    }
    key = normalizeKeyName(token);
  }

  if (key === null) throw new KeybindingSyntaxError('no non-modifier key', spec);
  return { key, ctrl, shift, alt, meta };
}

/** Canonical chord string. Modifier order is fixed so two spellings compare equal. */
export function formatKeystroke(keystroke: Keystroke): string {
  const parts: string[] = [];
  if (keystroke.ctrl) parts.push('ctrl');
  if (keystroke.shift) parts.push('shift');
  if (keystroke.alt) parts.push('alt');
  if (keystroke.meta) parts.push('meta');
  parts.push(KEY_DISPLAY[keystroke.key] ?? keystroke.key);
  return parts.join('+');
}

/** The subset of `KeyboardEvent` we depend on, so this module stays DOM-free. */
export interface KeyboardEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

export function keystrokeFromEvent(event: KeyboardEventLike): Keystroke {
  return {
    key: normalizeKeyName(event.key),
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
  };
}

// ---------------------------------------------------------------------------
// User-editable keybindings JSON
// ---------------------------------------------------------------------------

export const KeybindingRuleSchema = z.object({
  commandId: z.string().min(1),
  key: z.string().min(1),
  mac: z.string().min(1).optional(),
  when: z.string().min(1).optional(),
  priority: z.number().int().optional(),
  args: z.record(z.unknown()).optional(),
  family: z.string().min(1).optional(),
});

export const KeybindingFileSchema = z.array(KeybindingRuleSchema);

export interface KeybindingLoadResult {
  readonly rules: readonly KeybindingRule[];
  /** One message per rejected entry. A bad entry must not discard the whole file. */
  readonly errors: readonly string[];
}

/**
 * Parse a user keybindings file. Invalid entries are reported and skipped rather than
 * thrown, so one typo cannot leave the user with no keyboard at all.
 */
export function parseKeybindingsFile(input: unknown): KeybindingLoadResult {
  const parsed = KeybindingFileSchema.safeParse(input);
  if (!parsed.success) {
    return { rules: [], errors: [`keybindings file must be an array of rules: ${parsed.error.message}`] };
  }

  const rules: KeybindingRule[] = [];
  const errors: string[] = [];

  parsed.data.forEach((rule, index) => {
    try {
      parseKeystroke(rule.key);
      if (rule.mac !== undefined) parseKeystroke(rule.mac);
      if (rule.when !== undefined) parseWhen(rule.when);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`rule ${index} (${rule.commandId}): ${message}`);
      return;
    }
    rules.push({
      commandId: rule.commandId,
      key: rule.key,
      source: 'user',
      ...(rule.mac === undefined ? {} : { mac: rule.mac }),
      ...(rule.when === undefined ? {} : { when: rule.when }),
      ...(rule.priority === undefined ? {} : { priority: rule.priority }),
      ...(rule.args === undefined ? {} : { args: rule.args }),
      ...(rule.family === undefined ? {} : { family: rule.family }),
    });
  });

  return { rules, errors };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface KeybindingMatch {
  readonly binding: ResolvedKeybinding;
  readonly commandId: string;
  readonly args: CommandArgs | undefined;
}

export class KeybindingRegistry {
  readonly #byChord = new Map<string, ResolvedKeybinding[]>();
  readonly #platform: Platform;
  #ordinal = 0;

  constructor(platform: Platform = 'mac') {
    this.#platform = platform;
  }

  get platform(): Platform {
    return this.#platform;
  }

  get size(): number {
    let total = 0;
    for (const bindings of this.#byChord.values()) total += bindings.length;
    return total;
  }

  /** Register one rule. Throws on a malformed chord or `when` clause. */
  register(rule: KeybindingRule): () => void {
    const spec = this.#platform === 'mac' && rule.mac !== undefined ? rule.mac : rule.key;
    const keystroke = parseKeystroke(spec);
    const chord = formatKeystroke(keystroke);

    this.#ordinal += 1;
    const binding: ResolvedKeybinding = {
      commandId: rule.commandId,
      keystroke,
      chord,
      when: rule.when === undefined ? null : parseWhen(rule.when),
      priority: rule.priority ?? 0,
      args: rule.args,
      source: rule.source ?? 'default',
      family: rule.family ?? null,
      ordinal: this.#ordinal,
    };

    const existing = this.#byChord.get(chord);
    if (existing === undefined) this.#byChord.set(chord, [binding]);
    else existing.push(binding);

    return () => {
      const bindings = this.#byChord.get(chord);
      if (bindings === undefined) return;
      const index = bindings.indexOf(binding);
      if (index >= 0) bindings.splice(index, 1);
      if (bindings.length === 0) this.#byChord.delete(chord);
    };
  }

  registerAll(rules: readonly KeybindingRule[]): () => void {
    const disposers = rules.map((rule) => this.register(rule));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  /**
   * Every binding the registry holds, in a stable order.
   *
   * The help page is rendered from this rather than from `DEFAULT_KEYBINDINGS` (`D02`): the
   * default table is only what the app shipped with, and a user override loaded through
   * `loadUserKeybindings` would leave a sheet built from the table describing keys that no
   * longer do anything.
   *
   * In registration order, which is the order the scheme declares itself in: a family reads as
   * the run of keys its table wrote, and a user's own bindings arrive after the defaults they
   * were loaded on top of.
   */
  all(): readonly ResolvedKeybinding[] {
    const bindings: ResolvedKeybinding[] = [];
    for (const forChord of this.#byChord.values()) bindings.push(...forChord);
    return bindings.sort((a, b) => a.ordinal - b.ordinal);
  }

  /** Every binding registered for a chord, best candidate first. */
  bindingsForChord(chord: string): readonly ResolvedKeybinding[] {
    const keystroke = parseKeystroke(chord);
    return [...(this.#byChord.get(formatKeystroke(keystroke)) ?? [])].sort(compareBindings);
  }

  /** Every chord bound to a command, for rendering shortcuts next to palette entries. */
  chordsForCommand(commandId: string): string[] {
    const chords: string[] = [];
    for (const bindings of this.#byChord.values()) {
      for (const binding of bindings) {
        if (binding.commandId === commandId) chords.push(binding.chord);
      }
    }
    return [...new Set(chords)].sort();
  }

  /**
   * Resolve a keystroke to the command that should run.
   *
   * When `commands` is supplied, a binding whose command is missing or disabled in this
   * context is skipped and the next candidate is tried. Returns `null` when nothing
   * matches, which the caller reads as "let the keystroke through to the DOM".
   */
  resolve(
    keystroke: Keystroke,
    context: ContextSnapshot,
    commands?: CommandRegistry,
  ): KeybindingMatch | null {
    const candidates = this.#byChord.get(formatKeystroke(keystroke));
    if (candidates === undefined || candidates.length === 0) return null;

    for (const binding of [...candidates].sort(compareBindings)) {
      if (binding.when !== null && !evaluateWhen(binding.when, context)) continue;
      if (commands !== undefined && !commands.isEnabled(binding.commandId, context)) continue;
      return { binding, commandId: binding.commandId, args: binding.args };
    }
    return null;
  }

  /** Convenience: resolve directly from a keyboard event. */
  resolveEvent(
    event: KeyboardEventLike,
    context: ContextSnapshot,
    commands?: CommandRegistry,
  ): KeybindingMatch | null {
    return this.resolve(keystrokeFromEvent(event), context, commands);
  }
}

/** Sort comparator: the binding that should win comes first. */
function compareBindings(a: ResolvedKeybinding, b: ResolvedKeybinding): number {
  if (a.source !== b.source) return a.source === 'user' ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  const aSpecific = a.when !== null ? 1 : 0;
  const bSpecific = b.when !== null ? 1 : 0;
  if (aSpecific !== bSpecific) return bSpecific - aSpecific;
  return b.ordinal - a.ordinal;
}
