/**
 * Reading a headless `claude --output-format stream-json`.
 *
 * The CLI emits one JSON object per line and its vocabulary is wider than anything we act on:
 * hook lifecycle records, thinking-token counters, rate-limit notices. Rather than enumerate
 * what to ignore — a list that goes stale the moment the CLI grows an event kind — this parses
 * what it recognises and returns `null` for everything else. An unknown event is not an error;
 * it is a line from a newer CLI than the one this was written against.
 *
 * `docs/AGENTS.md`: if output must be machine-readable, validate it on the way *in*. These
 * schemas are that boundary. Nothing downstream reads a raw line.
 *
 * The shapes are taken from a recorded transcript, not from a guess:
 * `tests/fixtures/agents/librarian-stream.jsonl`.
 */
import { z } from 'zod';

/** What a run tells the app it is doing. Deliberately coarse: this drives a progress line. */
export type AgentEvent =
  | {
      readonly kind: 'started';
      readonly sessionId: string;
      readonly model: string;
      readonly tools: readonly string[];
    }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'tool'; readonly tool: string; readonly target: string | null }
  | { readonly kind: 'tool-result'; readonly isError: boolean }
  | {
      readonly kind: 'finished';
      readonly ok: boolean;
      readonly summary: string;
      readonly turns: number;
      readonly durationMs: number;
      readonly costUsd: number | null;
    };

const InitSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
});

const ContentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking') }).passthrough(),
  z.object({
    type: z.literal('tool_use'),
    name: z.string(),
    input: z.record(z.unknown()).optional(),
  }),
  z.object({ type: z.literal('tool_result'), is_error: z.boolean().optional() }).passthrough(),
  // A block kind this build has never seen. Recognised as a block, acted on as nothing.
  z.object({ type: z.string() }).passthrough(),
]);

const MessageSchema = z.object({
  type: z.enum(['assistant', 'user']),
  message: z.object({ content: z.union([z.string(), z.array(ContentBlockSchema)]) }).passthrough(),
});

const ResultSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  num_turns: z.number().int().nonnegative().optional(),
  duration_ms: z.number().nonnegative().optional(),
  total_cost_usd: z.number().nonnegative().nullish(),
});

/**
 * Which of a tool call's arguments is worth showing.
 *
 * A progress line saying "Read" is close to useless; "Read attention.md" says where the run
 * has got to. Only the arguments that name a place are eligible — never the whole input,
 * which for a `Write` is the entire file.
 */
const TARGET_KEYS = ['file_path', 'path', 'pattern', 'notebook_path', 'command'] as const;

function toolTarget(input: Record<string, unknown> | undefined): string | null {
  if (input === undefined) return null;
  for (const key of TARGET_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 200 ? `${value.slice(0, 197)}...` : value;
    }
  }
  return null;
}

/**
 * Parse one line into the events it carries.
 *
 * An assistant message holds a *list* of blocks — text, thinking, several tool calls — so one
 * line can be several events. Returning an array rather than one event is what keeps a
 * two-tool-call turn from silently reporting a single call.
 */
export function parseStreamLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    // The CLI writes JSON; anything else on stdout is noise from a wrapper script or a shell
    // profile, and is not worth failing a run over.
    return [];
  }

  const init = InitSchema.safeParse(raw);
  if (init.success) {
    return [
      {
        kind: 'started',
        sessionId: init.data.session_id,
        model: init.data.model,
        tools: init.data.tools,
      },
    ];
  }

  const result = ResultSchema.safeParse(raw);
  if (result.success) {
    return [
      {
        kind: 'finished',
        ok: !result.data.is_error,
        summary: result.data.result ?? '',
        turns: result.data.num_turns ?? 0,
        durationMs: result.data.duration_ms ?? 0,
        costUsd: result.data.total_cost_usd ?? null,
      },
    ];
  }

  const message = MessageSchema.safeParse(raw);
  if (!message.success) return [];

  const content = message.data.message.content;
  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'message', text: content }] : [];
  }

  const events: AgentEvent[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text': {
        const text = 'text' in block ? block.text : '';
        if (typeof text === 'string' && text.trim().length > 0) {
          events.push({ kind: 'message', text });
        }
        break;
      }
      case 'thinking':
        events.push({ kind: 'thinking' });
        break;
      case 'tool_use': {
        const name = 'name' in block && typeof block.name === 'string' ? block.name : 'unknown';
        const input =
          'input' in block && typeof block.input === 'object' && block.input !== null
            ? (block.input as Record<string, unknown>)
            : undefined;
        events.push({ kind: 'tool', tool: name, target: toolTarget(input) });
        break;
      }
      case 'tool_result':
        events.push({
          kind: 'tool-result',
          isError: 'is_error' in block ? block.is_error === true : false,
        });
        break;
      default:
        break;
    }
  }
  return events;
}

/**
 * Turn a stream of chunks into a stream of lines.
 *
 * A pipe splits wherever it likes, and one of the recorded events is 20 kB of file content, so
 * a chunk boundary in the middle of a JSON object is the normal case rather than the edge one.
 * Anything before the last newline is complete; the remainder is held until more arrives.
 */
export class LineSplitter {
  #buffer = '';

  push(chunk: string): string[] {
    this.#buffer += chunk;
    const parts = this.#buffer.split('\n');
    this.#buffer = parts.pop() ?? '';
    return parts;
  }

  /** Whatever is left when the stream closes without a trailing newline. */
  flush(): string[] {
    const rest = this.#buffer;
    this.#buffer = '';
    return rest.length > 0 ? [rest] : [];
  }
}
