import {
  evaluateWhen,
  parseWhen,
  type ContextSnapshot,
  type WhenExpression,
} from './context.js';

/**
 * The command registry.
 *
 * Panels never call each other. A panel raises a command by id and the registry dispatches
 * it, which is what makes the workspace composable: the library sidebar, a search result,
 * a link decoration, the command palette and a keybinding all open a document through the
 * exact same code path.
 *
 * Commands carry the metadata the palette needs (category, title, natural-language
 * keywords) and an optional `when` clause, so a command that makes no sense in the current
 * focus is neither executable nor offered.
 */

export type CommandArgs = Readonly<Record<string, unknown>>;

export type CommandHandler = (
  args: CommandArgs,
  context: ContextSnapshot,
) => unknown | Promise<unknown>;

export interface CommandDefinition {
  readonly id: string;
  /** Human title without the category, e.g. "Find All References". */
  readonly title: string;
  /** Palette group, e.g. "Links". Rendered as "Links: Find All References". */
  readonly category: string;
  /** Extra natural-language terms so the palette finds a command by intent. */
  readonly keywords?: readonly string[];
  /** Context expression gating execution. Absent means always enabled. */
  readonly when?: string;
  readonly handler: CommandHandler;
}

export interface RegisteredCommand {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly keywords: readonly string[];
  /** `"<category>: <title>"`, the palette's display string. */
  readonly label: string;
  readonly when: WhenExpression | null;
  readonly handler: CommandHandler;
}

export class CommandNotFoundError extends Error {
  readonly commandId: string;
  constructor(commandId: string) {
    super(`no command registered with id \`${commandId}\``);
    this.name = 'CommandNotFoundError';
    this.commandId = commandId;
  }
}

export class CommandDisabledError extends Error {
  readonly commandId: string;
  readonly when: string;
  constructor(commandId: string, when: string) {
    super(`command \`${commandId}\` is disabled in this context (when: ${when})`);
    this.name = 'CommandDisabledError';
    this.commandId = commandId;
    this.when = when;
  }
}

export class DuplicateCommandError extends Error {
  readonly commandId: string;
  constructor(commandId: string) {
    super(`command \`${commandId}\` is already registered`);
    this.name = 'DuplicateCommandError';
    this.commandId = commandId;
  }
}

const NO_ARGS: CommandArgs = Object.freeze({});
const NO_CONTEXT: ContextSnapshot = Object.freeze({});

export interface CommandSearchResult {
  readonly command: RegisteredCommand;
  /** Higher is better. Only meaningful relative to other results of the same query. */
  readonly score: number;
  readonly enabled: boolean;
}

/**
 * Scores a query against one searchable field. Exact match beats prefix beats substring
 * beats subsequence, which is enough to make "far" find "Find All References" while
 * keeping "Open Document" above "Open Document to the Side" for the query "open document".
 */
function scoreField(field: string, query: string): number {
  if (field.length === 0) return 0;
  const haystack = field.toLowerCase();
  if (haystack === query) return 100;
  if (haystack.startsWith(query)) return 80 - Math.min(20, haystack.length - query.length) / 4;

  const index = haystack.indexOf(query);
  if (index >= 0) return 60 - Math.min(40, index);

  // Subsequence match: every query character in order, e.g. "far" -> "Find All References".
  let cursor = 0;
  let gaps = 0;
  for (const char of query) {
    if (char === ' ') continue;
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return 0;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return Math.max(1, 30 - Math.min(25, gaps));
}

/** Initials of each word, so "far" matches "Find All References". */
function initialsOf(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0] ?? '')
    .join('')
    .toLowerCase();
}

export class CommandRegistry {
  readonly #commands = new Map<string, RegisteredCommand>();

  /**
   * Register a command. Returns a disposer so a panel can unregister its contributions
   * when it closes. Re-registering an id is a programming error, not a silent overwrite.
   */
  register(definition: CommandDefinition): () => void {
    if (this.#commands.has(definition.id)) throw new DuplicateCommandError(definition.id);

    const command: RegisteredCommand = {
      id: definition.id,
      title: definition.title,
      category: definition.category,
      keywords: definition.keywords ?? [],
      label: `${definition.category}: ${definition.title}`,
      // parseWhen throws here rather than at keystroke time: a bad `when` in our own
      // command table should fail at startup, loudly.
      when: definition.when === undefined ? null : parseWhen(definition.when),
      handler: definition.handler,
    };

    this.#commands.set(command.id, command);
    return () => {
      if (this.#commands.get(command.id) === command) this.#commands.delete(command.id);
    };
  }

  registerAll(definitions: readonly CommandDefinition[]): () => void {
    const disposers = definitions.map((definition) => this.register(definition));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  has(id: string): boolean {
    return this.#commands.has(id);
  }

  get(id: string): RegisteredCommand | undefined {
    return this.#commands.get(id);
  }

  all(): readonly RegisteredCommand[] {
    return [...this.#commands.values()];
  }

  get size(): number {
    return this.#commands.size;
  }

  /** Whether the command exists and its `when` clause holds in this context. */
  isEnabled(id: string, context: ContextSnapshot = NO_CONTEXT): boolean {
    const command = this.#commands.get(id);
    if (command === undefined) return false;
    if (command.when === null) return true;
    return evaluateWhen(command.when, context);
  }

  /**
   * Execute a command. Throws `CommandNotFoundError` for an unknown id and
   * `CommandDisabledError` when the context gate fails — a disabled command must not
   * quietly no-op, or a broken keybinding is indistinguishable from a broken feature.
   */
  async execute(
    id: string,
    args: CommandArgs = NO_ARGS,
    context: ContextSnapshot = NO_CONTEXT,
  ): Promise<unknown> {
    const command = this.#commands.get(id);
    if (command === undefined) throw new CommandNotFoundError(id);
    if (command.when !== null && !evaluateWhen(command.when, context)) {
      throw new CommandDisabledError(id, command.when.source);
    }
    return await command.handler(args, context);
  }

  /**
   * Command-palette search over label, id and keywords. An empty query lists everything
   * alphabetically. Results are ordered best-first; disabled commands are still returned
   * but flagged, matching VS Code, which greys them rather than hiding them.
   */
  search(query: string, context: ContextSnapshot = NO_CONTEXT): CommandSearchResult[] {
    const needle = query.trim().toLowerCase();

    if (needle.length === 0) {
      return [...this.#commands.values()]
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((command) => ({
          command,
          score: 1,
          enabled: this.isEnabled(command.id, context),
        }));
    }

    const results: CommandSearchResult[] = [];
    for (const command of this.#commands.values()) {
      const scores = [
        scoreField(command.label, needle),
        scoreField(command.title, needle) - 1,
        scoreField(command.id, needle) - 5,
        scoreField(initialsOf(command.title), needle) - 2,
        ...command.keywords.map((keyword) => scoreField(keyword, needle) - 3),
      ];
      const score = Math.max(...scores);
      if (score > 0) results.push({ command, score, enabled: this.isEnabled(command.id, context) });
    }

    return results.sort(
      (a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label),
    );
  }
}
