/**
 * Context keys and `when` expressions.
 *
 * Keybindings and commands must activate only where they make sense: F12 means "go to
 * target" in a reader but must not steal the key from a note editor's text input. VS Code
 * solves this with context keys plus a boolean `when` expression, and so do we.
 *
 * The grammar is deliberately small — identifiers, `!`, `&&`, `||`, parentheses, and
 * `==` / `!=` comparisons against a literal. It is enough for every condition in
 * docs/SPEC.md and small enough to evaluate on every keystroke without allocating.
 *
 * Parsing throws; evaluation never does. `when` clauses come from our own source and from
 * a user-editable JSON file, so a syntax error must surface loudly at load time rather
 * than silently disabling a key at 2am.
 */

export type ContextValue = string | number | boolean;
export type ContextSnapshot = Readonly<Record<string, ContextValue>>;

/**
 * Context keys the workbench sets. Listed in docs/SPEC.md; kept here so a typo in a `when`
 * clause can be caught by `validateWhenKeys` rather than silently never matching.
 */
export const WELL_KNOWN_CONTEXT_KEYS = [
  'readerFocus',
  'pdfReaderFocus',
  'htmlReaderFocus',
  'noteEditorFocus',
  'linkUnderCursor',
  'annotationSelected',
  'documentSelected',
  'referencesPanelFocus',
  'searchResultsFocus',
  'textInputFocus',
  'canGoToParent',
  'canGoBack',
  'canGoForward',
  'activePanelKind',
  'platform',
] as const;

export type WellKnownContextKey = (typeof WELL_KNOWN_CONTEXT_KEYS)[number];

export class WhenSyntaxError extends Error {
  readonly source: string;
  readonly position: number;

  constructor(message: string, source: string, position: number) {
    super(`${message} (at ${position} in \`${source}\`)`);
    this.name = 'WhenSyntaxError';
    this.source = source;
    this.position = position;
  }
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type WhenNode =
  | { readonly kind: 'key'; readonly name: string }
  | { readonly kind: 'literal'; readonly value: boolean }
  | { readonly kind: 'not'; readonly operand: WhenNode }
  | { readonly kind: 'and'; readonly left: WhenNode; readonly right: WhenNode }
  | { readonly kind: 'or'; readonly left: WhenNode; readonly right: WhenNode }
  | {
      readonly kind: 'compare';
      readonly name: string;
      readonly op: '==' | '!=';
      readonly value: ContextValue;
    };

export interface WhenExpression {
  readonly source: string;
  readonly node: WhenNode;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'ident'; value: string; pos: number }
  | { kind: 'string'; value: string; pos: number }
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'op'; value: '&&' | '||' | '!' | '(' | ')' | '==' | '!='; pos: number };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_.]/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i] ?? '';

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      i += 1;
      continue;
    }

    const pos = i;

    if (char === '&' || char === '|') {
      if (source[i + 1] !== char) {
        throw new WhenSyntaxError(`expected \`${char}${char}\``, source, pos);
      }
      tokens.push({ kind: 'op', value: char === '&' ? '&&' : '||', pos });
      i += 2;
      continue;
    }

    if (char === '=') {
      if (source[i + 1] !== '=') throw new WhenSyntaxError('expected `==`', source, pos);
      tokens.push({ kind: 'op', value: '==', pos });
      i += 2;
      continue;
    }

    if (char === '!') {
      if (source[i + 1] === '=') {
        tokens.push({ kind: 'op', value: '!=', pos });
        i += 2;
      } else {
        tokens.push({ kind: 'op', value: '!', pos });
        i += 1;
      }
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({ kind: 'op', value: char, pos });
      i += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== quote) {
        value += source[i];
        i += 1;
      }
      if (i >= source.length) throw new WhenSyntaxError('unterminated string', source, pos);
      i += 1; // closing quote
      tokens.push({ kind: 'string', value, pos });
      continue;
    }

    if (char >= '0' && char <= '9') {
      let raw = '';
      while (i < source.length) {
        const digit = source[i] ?? '';
        if (!/[0-9.]/.test(digit)) break;
        raw += digit;
        i += 1;
      }
      const value = Number(raw);
      if (Number.isNaN(value)) throw new WhenSyntaxError(`bad number \`${raw}\``, source, pos);
      tokens.push({ kind: 'number', value, pos });
      continue;
    }

    if (IDENT_START.test(char)) {
      let value = '';
      while (i < source.length && IDENT_PART.test(source[i] ?? '')) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'ident', value, pos });
      continue;
    }

    throw new WhenSyntaxError(`unexpected character \`${char}\``, source, pos);
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent; `||` binds loosest, then `&&`, then `!`)
// ---------------------------------------------------------------------------

class Parser {
  readonly #tokens: Token[];
  readonly #source: string;
  #index = 0;

  constructor(tokens: Token[], source: string) {
    this.#tokens = tokens;
    this.#source = source;
  }

  #peek(): Token | undefined {
    return this.#tokens[this.#index];
  }

  #next(): Token | undefined {
    const token = this.#tokens[this.#index];
    this.#index += 1;
    return token;
  }

  #endPosition(): number {
    return this.#source.length;
  }

  parse(): WhenNode {
    const node = this.#parseOr();
    const trailing = this.#peek();
    if (trailing !== undefined) {
      throw new WhenSyntaxError('unexpected trailing input', this.#source, trailing.pos);
    }
    return node;
  }

  #parseOr(): WhenNode {
    let left = this.#parseAnd();
    for (;;) {
      const token = this.#peek();
      if (token === undefined || token.kind !== 'op' || token.value !== '||') return left;
      this.#next();
      const right = this.#parseAnd();
      left = { kind: 'or', left, right };
    }
  }

  #parseAnd(): WhenNode {
    let left = this.#parseUnary();
    for (;;) {
      const token = this.#peek();
      if (token === undefined || token.kind !== 'op' || token.value !== '&&') return left;
      this.#next();
      const right = this.#parseUnary();
      left = { kind: 'and', left, right };
    }
  }

  #parseUnary(): WhenNode {
    const token = this.#peek();
    if (token !== undefined && token.kind === 'op' && token.value === '!') {
      this.#next();
      return { kind: 'not', operand: this.#parseUnary() };
    }
    return this.#parsePrimary();
  }

  #parsePrimary(): WhenNode {
    const token = this.#next();
    if (token === undefined) {
      throw new WhenSyntaxError('unexpected end of expression', this.#source, this.#endPosition());
    }

    if (token.kind === 'op' && token.value === '(') {
      const inner = this.#parseOr();
      const close = this.#next();
      if (close === undefined || close.kind !== 'op' || close.value !== ')') {
        throw new WhenSyntaxError(
          'expected `)`',
          this.#source,
          close?.pos ?? this.#endPosition(),
        );
      }
      return inner;
    }

    if (token.kind !== 'ident') {
      throw new WhenSyntaxError('expected a context key', this.#source, token.pos);
    }

    if (token.value === 'true' || token.value === 'false') {
      return { kind: 'literal', value: token.value === 'true' };
    }

    const operator = this.#peek();
    if (
      operator !== undefined &&
      operator.kind === 'op' &&
      (operator.value === '==' || operator.value === '!=')
    ) {
      this.#next();
      const literal = this.#next();
      if (literal === undefined) {
        throw new WhenSyntaxError(
          'expected a value after the comparison',
          this.#source,
          this.#endPosition(),
        );
      }
      let value: ContextValue;
      if (literal.kind === 'string') value = literal.value;
      else if (literal.kind === 'number') value = literal.value;
      else if (literal.kind === 'ident' && (literal.value === 'true' || literal.value === 'false'))
        value = literal.value === 'true';
      else throw new WhenSyntaxError('expected a literal value', this.#source, literal.pos);

      return { kind: 'compare', name: token.value, op: operator.value, value };
    }

    return { kind: 'key', name: token.value };
  }
}

/** Parse a `when` clause. Throws `WhenSyntaxError` on malformed input. */
export function parseWhen(source: string): WhenExpression {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new WhenSyntaxError('empty expression', source, 0);
  }
  return { source: trimmed, node: new Parser(tokenize(trimmed), trimmed).parse() };
}

/** Parse without throwing. Returns `null` for malformed input. */
export function tryParseWhen(source: string): WhenExpression | null {
  try {
    return parseWhen(source);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** A bare key is truthy when it is `true`, a non-empty string, or a non-zero number. */
function isTruthy(value: ContextValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value.length > 0;
}

function evaluateNode(node: WhenNode, context: ContextSnapshot): boolean {
  switch (node.kind) {
    case 'key':
      return isTruthy(context[node.name]);
    case 'literal':
      return node.value;
    case 'not':
      return !evaluateNode(node.operand, context);
    case 'and':
      return evaluateNode(node.left, context) && evaluateNode(node.right, context);
    case 'or':
      return evaluateNode(node.left, context) || evaluateNode(node.right, context);
    case 'compare': {
      // An unset key compares equal to nothing, so `!=` against an unset key is true.
      const actual = context[node.name];
      const equal = actual === node.value;
      return node.op === '==' ? equal : !equal;
    }
    default: {
      const exhaustive: never = node;
      throw new Error(`unhandled when node: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Evaluate a parsed expression against a context snapshot. Never throws. */
export function evaluateWhen(expression: WhenExpression, context: ContextSnapshot): boolean {
  return evaluateNode(expression.node, context);
}

/** Every context key referenced by an expression. Used to validate and to invalidate. */
export function whenKeys(expression: WhenExpression): string[] {
  const found = new Set<string>();
  const walk = (node: WhenNode): void => {
    switch (node.kind) {
      case 'key':
      case 'compare':
        found.add(node.name);
        return;
      case 'literal':
        return;
      case 'not':
        walk(node.operand);
        return;
      case 'and':
      case 'or':
        walk(node.left);
        walk(node.right);
        return;
      default: {
        const exhaustive: never = node;
        throw new Error(`unhandled when node: ${JSON.stringify(exhaustive)}`);
      }
    }
  };
  walk(expression.node);
  return [...found].sort();
}

/** Keys referenced by an expression that the workbench never sets — almost always a typo. */
export function unknownWhenKeys(expression: WhenExpression): string[] {
  const known = new Set<string>(WELL_KNOWN_CONTEXT_KEYS);
  return whenKeys(expression).filter((key) => !known.has(key));
}

// ---------------------------------------------------------------------------
// Context key service
// ---------------------------------------------------------------------------

export type ContextChangeListener = (snapshot: ContextSnapshot, changed: readonly string[]) => void;

/**
 * Mutable context key store. Panels set keys as focus moves; the keybinding registry reads
 * a snapshot. Listeners fire once per mutation batch with the keys that actually changed,
 * so a re-render is not triggered by setting a key to the value it already had.
 */
export class ContextKeyService {
  readonly #values = new Map<string, ContextValue>();
  readonly #listeners = new Set<ContextChangeListener>();

  get(key: string): ContextValue | undefined {
    return this.#values.get(key);
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  set(key: string, value: ContextValue): void {
    this.setMany({ [key]: value });
  }

  remove(key: string): void {
    if (!this.#values.has(key)) return;
    this.#values.delete(key);
    this.#emit([key]);
  }

  /** Apply several keys as one batch. `undefined` removes a key. */
  setMany(values: Readonly<Record<string, ContextValue | undefined>>): void {
    const changed: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        if (this.#values.delete(key)) changed.push(key);
        continue;
      }
      if (this.#values.get(key) === value) continue;
      this.#values.set(key, value);
      changed.push(key);
    }
    if (changed.length > 0) this.#emit(changed);
  }

  snapshot(): ContextSnapshot {
    return Object.fromEntries(this.#values);
  }

  /** Evaluate a `when` source string against the live context. Malformed input is `false`. */
  matches(when: string | undefined): boolean {
    if (when === undefined) return true;
    const expression = tryParseWhen(when);
    if (expression === null) return false;
    return evaluateWhen(expression, this.snapshot());
  }

  onDidChange(listener: ContextChangeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  clear(): void {
    const changed = [...this.#values.keys()];
    this.#values.clear();
    if (changed.length > 0) this.#emit(changed);
  }

  #emit(changed: readonly string[]): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot, changed);
  }
}
