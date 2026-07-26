/**
 * What a run may hand back.
 *
 * The librarian proposes; nothing it writes lands without an explicit accept. A run stages
 * markdown files in `.runs/<id>/proposals/`, and this module is the gate between those files
 * and anything a person is shown. Everything the criteria promise about a proposal is decided
 * *here*, on the way in, rather than requested in the prompt on the way out:
 *
 * - `A04` — every citation is resolved against the database. An agent asked for citations will
 *   produce citation-shaped text whether or not the documents exist, so a proposal carrying one
 *   id that resolves to nothing is refused whole. Partial acceptance would leave a note in the
 *   wiki asserting a source that is not there, which is worse than no note.
 * - `A06` — a connection names *both* threads it joins, and why. Two distinct resolving ids and
 *   a non-empty body, or it is not a connection.
 * - `A07` — a contradiction cites both sides.
 * - `A08` — evidence for a question is surfaced supporting *and* opposing, each cited.
 * - `A09` — a proposal whose capability is switched off is dropped, whatever the prompt said.
 *   This is the half that makes the switch real: the prompt line is a request, and a run that
 *   suggests a direction anyway is exactly the case the flag exists to survive.
 * - `A12` — a note records which documents it covers, and they resolve.
 *
 * The front-matter reader below is deliberately tiny — `key: value` and `key: [a, b]`, nothing
 * else. A general YAML parser would be a large surface pointed at text an agent wrote after
 * reading a saved web page, and none of the extra grammar buys anything.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WikiReaderDatabase } from '@wr/database';
import type { LinkableEntityType } from '@wr/shared-types';
import type { AgentWorkspace } from './workspace.js';
import type { LibrarianCapability } from './prompt.js';
import type { Logger } from '../logger.js';

export const PROPOSAL_KINDS = ['connection', 'contradiction', 'evidence', 'direction'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/**
 * Which capability has to be on for a kind of proposal to be accepted. The map is the same
 * data the prompt is built from, which is what keeps switching one off from being two edits.
 */
const KIND_CAPABILITY: Readonly<Record<ProposalKind, LibrarianCapability>> = {
  connection: 'connect',
  contradiction: 'contradict',
  evidence: 'evidence',
  direction: 'directions',
};

/** A cited entity, after it has been found. There is no unresolved citation type on purpose. */
export interface Citation {
  readonly entityType: LinkableEntityType;
  readonly entityId: string;
  readonly title: string;
  /** The document this citation is *in*, so `A10` can open something. */
  readonly documentId: string | null;
  /** Where in that document, when the entity has a location. Null for a whole document. */
  readonly location: unknown;
}

export interface Proposal {
  readonly id: string;
  readonly runId: string;
  readonly kind: ProposalKind;
  readonly title: string;
  readonly body: string;
  /** Every entity the proposal names, resolved. Empty is impossible except for a direction. */
  readonly citations: readonly Citation[];
  /** `A12`: the documents this note covers. */
  readonly covers: readonly Citation[];
  /** `A06`: the threads a connection joins. At least two, and distinct. */
  readonly threads: readonly Citation[];
  /** `A07`: both sides of a contradiction. */
  readonly sides: readonly Citation[];
  /** `A08`: the question, and the evidence on each side of it. */
  readonly question: Citation | null;
  readonly supporting: readonly Citation[];
  readonly opposing: readonly Citation[];
  /** Workspace-relative path of the staged file this came from. */
  readonly sourcePath: string;
}

export type RejectionReason =
  | 'unknown-kind'
  | 'capability-off'
  | 'unresolved-citation'
  | 'missing-threads'
  | 'missing-sides'
  | 'missing-evidence'
  | 'missing-body'
  | 'missing-title';

export interface Rejection {
  readonly file: string;
  readonly reason: RejectionReason;
  readonly detail: string;
}

export interface Harvest {
  readonly proposals: readonly Proposal[];
  readonly rejected: readonly Rejection[];
}

export interface ProposalReaderOptions {
  readonly workspace: AgentWorkspace;
  readonly db: WikiReaderDatabase;
  readonly logger: Logger;
}

export class ProposalReader {
  readonly #workspace: AgentWorkspace;
  readonly #db: WikiReaderDatabase;
  readonly #logger: Logger;

  constructor(options: ProposalReaderOptions) {
    this.#workspace = options.workspace;
    this.#db = options.db;
    this.#logger = options.logger.child('proposals');
  }

  /**
   * Read everything a run staged, and return only what survives the boundary.
   *
   * A rejection is not an error: the run happened, and some of what it produced was not
   * usable. It is logged with the reason so a pattern of them is visible.
   */
  async harvest(
    runId: string,
    enabledCapabilities: readonly LibrarianCapability[],
  ): Promise<Harvest> {
    const directory = join('.runs', runId, 'proposals');
    const resolved = await this.#workspace.resolveWrite(directory);
    if (!resolved.ok) return { proposals: [], rejected: [] };

    let files: string[];
    try {
      files = (await readdir(resolved.path)).filter((name) => name.endsWith('.md')).sort();
    } catch {
      // A pass that found nothing writes nothing, so an absent directory is the expected
      // shape of a quiet run rather than a failure (`A13`).
      return { proposals: [], rejected: [] };
    }

    const proposals: Proposal[] = [];
    const rejected: Rejection[] = [];

    for (const file of files) {
      const relative = join(directory, file);
      const raw = await this.#workspace.read(relative);
      if (raw === null) continue;
      const outcome = this.#validate(runId, relative, file, raw, enabledCapabilities);
      if ('reason' in outcome) {
        rejected.push(outcome);
        this.#logger.warn('proposal refused', {
          runId,
          file,
          reason: outcome.reason,
          detail: outcome.detail,
        });
      } else {
        proposals.push(outcome);
      }
    }

    this.#logger.info('proposals harvested', {
      runId,
      accepted: proposals.length,
      rejected: rejected.length,
    });
    return { proposals, rejected };
  }

  #validate(
    runId: string,
    relative: string,
    file: string,
    raw: string,
    enabled: readonly LibrarianCapability[],
  ): Proposal | Rejection {
    const { front, body } = splitFrontMatter(raw);

    const kind = front.get('kind')?.[0];
    if (kind === undefined || !isProposalKind(kind)) {
      return { file, reason: 'unknown-kind', detail: String(kind) };
    }

    // Before anything is resolved: a capability that is off means the proposal does not
    // exist, whatever it says about itself and whatever the prompt asked for.
    if (!enabled.includes(KIND_CAPABILITY[kind])) {
      return { file, reason: 'capability-off', detail: KIND_CAPABILITY[kind] };
    }

    const title = front.get('title')?.[0]?.trim() ?? '';
    if (title.length === 0) return { file, reason: 'missing-title', detail: file };
    if (body.trim().length === 0) return { file, reason: 'missing-body', detail: title };

    // Everything the proposal names, from the front matter and from the body's wikilinks.
    // Resolving the union is what makes `A04` hold for a citation the agent only wrote in
    // prose, which is where most of them are.
    const named = new Set<string>([
      ...(front.get('threads') ?? []),
      ...(front.get('sides') ?? []),
      ...(front.get('supports') ?? []),
      ...(front.get('opposes') ?? []),
      ...(front.get('covers') ?? []),
      ...(front.get('question') ?? []),
      ...wikilinks(body),
    ]);

    const citations = new Map<string, Citation>();
    for (const id of named) {
      const citation = this.#resolve(id);
      if (citation === null) {
        return { file, reason: 'unresolved-citation', detail: id };
      }
      citations.set(id, citation);
    }

    const pick = (key: string): Citation[] =>
      (front.get(key) ?? [])
        .map((id) => citations.get(id))
        .filter((citation): citation is Citation => citation !== undefined);

    const threads = distinct(pick('threads'));
    const sides = distinct(pick('sides'));
    const supporting = distinct(pick('supports'));
    const opposing = distinct(pick('opposes'));
    const question = pick('question')[0] ?? null;

    if (kind === 'connection' && threads.length < 2) {
      return { file, reason: 'missing-threads', detail: `${threads.length} thread(s)` };
    }
    if (kind === 'contradiction' && sides.length < 2) {
      return { file, reason: 'missing-sides', detail: `${sides.length} side(s)` };
    }
    if (kind === 'evidence') {
      if (question === null || question.entityType !== 'question') {
        return { file, reason: 'missing-evidence', detail: 'no question' };
      }
      // Both sides, or it is not evidence *for and against*: a proposal listing only what
      // supports a question is the failure this criterion is about.
      if (supporting.length === 0 || opposing.length === 0) {
        return {
          file,
          reason: 'missing-evidence',
          detail: `${supporting.length} for, ${opposing.length} against`,
        };
      }
    }

    // `A12`: what the note covers. Declared when the agent declared it; otherwise every
    // document it cited, which is the same claim read off the citations.
    const declared = pick('covers');
    const covers = distinct(
      declared.length > 0
        ? declared
        : [...citations.values()].filter((citation) => citation.entityType === 'document'),
    );

    return {
      id: `${runId}:${file}`,
      runId,
      kind,
      title,
      body: body.trim(),
      citations: [...citations.values()],
      covers,
      threads,
      sides,
      question,
      supporting,
      opposing,
      sourcePath: relative,
    };
  }

  /**
   * Find what an id names, or nothing.
   *
   * The entity kind comes from the id's own prefix rather than from the agent saying which
   * table to look in — a proposal that could name its own table could ask for a lookup the
   * front matter's author chose.
   */
  #resolve(id: string): Citation | null {
    const entityType = entityTypeOf(id);
    if (entityType === null) return null;
    const found = this.#db.entities.describe(entityType, id);
    if (found === null) return null;
    return {
      entityType: found.entityType,
      entityId: found.entityId,
      title: found.title,
      documentId: found.documentId,
      location: found.location,
    };
  }
}

const ID_PREFIX_TO_TYPE: Readonly<Record<string, LinkableEntityType>> = {
  doc: 'document',
  ann: 'annotation',
  not: 'note',
  qst: 'question',
  chk: 'chunk',
  col: 'collection',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A journal entry's id is its date, which is why this is not a pure prefix table. */
export function entityTypeOf(id: string): LinkableEntityType | null {
  if (ISO_DATE.test(id)) return 'journal';
  const prefix = id.split('_')[0];
  if (prefix === undefined) return null;
  return ID_PREFIX_TO_TYPE[prefix] ?? null;
}

export function isProposalKind(value: string): value is ProposalKind {
  return (PROPOSAL_KINDS as readonly string[]).includes(value);
}

/** `[[id]]`, anywhere in the body. The link the agent was asked to write is the citation. */
export function wikilinks(body: string): string[] {
  const found: string[] = [];
  const pattern = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let match = pattern.exec(body);
  while (match !== null) {
    const id = match[1]?.trim();
    if (id !== undefined && id.length > 0) found.push(id);
    match = pattern.exec(body);
  }
  return found;
}

function distinct(citations: readonly Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    if (seen.has(citation.entityId)) return false;
    seen.add(citation.entityId);
    return true;
  });
}

/**
 * Split `---`-delimited front matter from the body.
 *
 * Understands exactly two forms — `key: value` and `key: [a, b, c]` — and ignores anything
 * else. Every key is stored as a list so the caller never has to ask which form was used.
 */
export function splitFrontMatter(raw: string): { front: Map<string, string[]>; body: string } {
  const front = new Map<string, string[]>();
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return { front, body: raw };

  // The closing delimiter is a line that is exactly `---`, found by scanning rather than by
  // searching for the substring: a body containing `----` would otherwise close the block.
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return { front, body: raw };

  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (key.length === 0 || key.startsWith('#')) continue;
    front.set(key, parseValue(line.slice(separator + 1).trim()));
  }
  return { front, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}

/**
 * A value is a list only when it is bracketed.
 *
 * Splitting an unbracketed value on commas would quietly truncate every title with a comma
 * in it at the first clause, which is most of the interesting ones.
 */
function parseValue(value: string): string[] {
  const unquote = (part: string): string => part.trim().replace(/^["']|["']$/g, '');
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map(unquote)
      .filter((part) => part.length > 0);
  }
  const single = unquote(value);
  return single.length === 0 ? [] : [single];
}
