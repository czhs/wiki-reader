/**
 * The librarian, assembled: read the wiki, run a pass, keep what survives the boundary, and
 * wait to be told what to do with it.
 *
 * The accept step is the point of the whole arrangement. A wiki that accumulates unread
 * machine output is a log, not a wiki, and the accept is where a person decides a thing is
 * true. So a run *never* writes into the workspace body: it stages, the boundary filters, the
 * rows land as `pending`, and accepting is the only code path that puts a file where the
 * researcher will read it (`A05`).
 *
 * A pass that finds nothing writes nothing (`A13`). That is the normal, correct outcome of a
 * pass over unchanged material, not a failure — an agent asked to improve a wiki will find
 * something to write every single time, and that padding is what makes a wiki worse slowly.
 * The run is still recorded, because "ran and found nothing" and "never ran" are different
 * facts and the schedule needs to tell them apart.
 */
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AgentRunRecord, StoredProposal, WikiReaderDatabase } from '@wr/database';
import type { AgentWorkspace } from './workspace.js';
import type { WikiView } from './wiki-view.js';
import type { LibrarianRunner } from './runner.js';
import type { Citation, Proposal, ProposalReader } from './proposals.js';
import { DEFAULT_CAPABILITIES, type LibrarianCapability } from './prompt.js';
import type { AgentEvent } from './stream.js';
import type { Logger } from '../logger.js';

/**
 * Kept short on purpose. The standing instructions are the system prompt's job.
 *
 * The wiki is named by absolute path rather than relative to the working directory. The run
 * happens in `<workspace>/.runs/<id>` and the view is the workspace's sibling, so every
 * relative form is one layout change away from pointing at nothing — and an agent that cannot
 * find the wiki produces an empty pass that looks exactly like a wiki with nothing new in it.
 */
const task = (wikiRoot: string): string => [
  `Make one pass over the wiki in ${wikiRoot}, which is read-only.`,
  '',
  'Write what you find as one markdown file per finding in ./proposals/, each with front',
  'matter: `kind` (connection, contradiction, evidence or direction), `title`, and the ids it',
  'turns on — `threads` for a connection, `sides` for a contradiction, `question` with',
  '`supports` and `opposes` for evidence. Add `covers` for the documents the note covers.',
  'Cite with [[id]] in the body. If this pass turns up nothing worth recording, write nothing.',
].join('\n');


export interface LibrarianServiceOptions {
  readonly db: WikiReaderDatabase;
  readonly workspace: AgentWorkspace;
  readonly view: WikiView;
  readonly runner: LibrarianRunner;
  readonly reader: ProposalReader;
  readonly logger: Logger;
}

export interface LibrarianPass {
  readonly run: AgentRunRecord;
  readonly proposals: readonly StoredProposal[];
  readonly rejected: number;
}

export class LibrarianService {
  readonly #db: WikiReaderDatabase;
  readonly #workspace: AgentWorkspace;
  readonly #view: WikiView;
  readonly #runner: LibrarianRunner;
  readonly #reader: ProposalReader;
  readonly #logger: Logger;
  /** Accepts in flight, by proposal id. See `accept`. */
  readonly #accepting = new Map<string, Promise<{ proposal: StoredProposal; path: string }>>();

  constructor(options: LibrarianServiceOptions) {
    this.#db = options.db;
    this.#workspace = options.workspace;
    this.#view = options.view;
    this.#runner = options.runner;
    this.#reader = options.reader;
    this.#logger = options.logger.child('librarian');
  }

  /** One pass. Materialise the wiki, run, harvest, record. Nothing lands in the body. */
  async pass(
    options: {
      readonly trigger: 'schedule' | 'import' | 'manual';
      readonly capabilities?: readonly LibrarianCapability[];
    },
    onEvent?: (event: AgentEvent, runId: string) => void,
  ): Promise<LibrarianPass> {
    const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
    const record = this.#db.agentRuns.start({
      capabilities: [...capabilities],
      trigger: options.trigger,
    });

    const view = await this.#view.materialise();
    const outcome = await this.#runner.run(
      { runId: record.id, task: task(view.root), readRoots: [view.root], capabilities },
      onEvent === undefined ? undefined : (event) => onEvent(event, record.id),
    );

    const harvest = await this.#reader.harvest(record.id, capabilities);
    const proposals = harvest.proposals.map((proposal) => this.#store(record.id, proposal));

    const finished = this.#db.agentRuns.finish(record.id, {
      status: outcome.cancelled ? 'cancelled' : outcome.ok ? 'finished' : 'failed',
      proposalCount: proposals.length,
      summary: outcome.summary.length === 0 ? null : outcome.summary.slice(0, 4000),
    });

    this.#logger.info('librarian pass complete', {
      runId: record.id,
      trigger: options.trigger,
      proposals: proposals.length,
      rejected: harvest.rejected.length,
    });

    return {
      run: finished ?? record,
      proposals,
      rejected: harvest.rejected.length,
    };
  }

  /**
   * Accept a proposal: write it into the workspace, and make it part of the wiki.
   *
   * The file is the editable artifact. There is no separate staging-and-editing step because
   * after this it is an ordinary markdown document, openable and annotatable like any other —
   * which is also what puts its citations in the graph.
   */
  async accept(proposalId: string): Promise<{ proposal: StoredProposal; path: string }> {
    // One decision per proposal, even when two arrive at once.
    //
    // `agent_proposals` protects its own row with `WHERE status = 'pending'`, but the accept
    // is not one statement: it writes a file and mints a document across two awaits, and the
    // pending check happens before both. Two clicks on Accept dispatch two concurrent invokes
    // — `ipcRenderer.invoke` does not serialise — and both pass that check. `documents_slug_idx`
    // is not unique, so the second `documents.create` lands and `upsertByPath` repoints the one
    // file row at it, leaving a librarian document with citation edges and no file behind it.
    //
    // Sharing the in-flight promise rather than refusing the second caller is deliberate: a
    // double click is one intention, and both callers should be told the same thing about it.
    // A *later* accept still fails on the status check, which is what `refuses to decide the
    // same proposal twice` covers.
    const inFlight = this.#accepting.get(proposalId);
    if (inFlight !== undefined) return inFlight;

    const work = this.#accept(proposalId);
    this.#accepting.set(proposalId, work);
    try {
      return await work;
    } finally {
      this.#accepting.delete(proposalId);
    }
  }

  async #accept(proposalId: string): Promise<{ proposal: StoredProposal; path: string }> {
    const stored = this.#db.agentRuns.getProposal(proposalId);
    if (stored === null) throw new Error(`No such proposal: ${proposalId}`);
    if (stored.status !== 'pending') {
      throw new Error(`Proposal ${proposalId} was already ${stored.status}.`);
    }

    const covers = stored.covers.filter(isCitation);
    const citations = stored.citations.filter(isCitation);
    const relative = join('notes', `${slugify(stored.title)}-${stored.id.slice(-6)}.md`);
    const markdown = renderNote(stored, citations, covers);

    const written = await this.#workspace.write(relative, markdown);
    if (!written.ok) throw new Error(`The workspace refused ${relative}: ${written.reason}`);

    const documentId = await this.#registerDocument(stored, written.path, relative, markdown);
    for (const citation of citations) {
      this.#db.links.create({
        type: 'librarian-note-cites',
        sourceType: 'document',
        sourceId: documentId,
        targetType: citation.entityType,
        targetId: citation.entityId,
      });
    }

    const accepted = this.#db.agentRuns.accept(stored.id, {
      workspacePath: written.relative,
      documentId,
    });
    this.#logger.info('proposal accepted', { proposalId, path: written.relative, documentId });
    return { proposal: accepted ?? stored, path: written.path };
  }

  /** Reject a proposal. Writes nothing: the decision is the whole of the effect. */
  reject(proposalId: string): StoredProposal {
    const stored = this.#db.agentRuns.getProposal(proposalId);
    if (stored === null) throw new Error(`No such proposal: ${proposalId}`);
    if (stored.status !== 'pending') {
      throw new Error(`Proposal ${proposalId} was already ${stored.status}.`);
    }
    const rejected = this.#db.agentRuns.reject(proposalId);
    this.#logger.info('proposal rejected', { proposalId });
    return rejected ?? stored;
  }

  #store(runId: string, proposal: Proposal): StoredProposal {
    return this.#db.agentRuns.propose({
      runId,
      kind: proposal.kind,
      title: proposal.title,
      body: proposal.body,
      citations: proposal.citations,
      covers: proposal.covers,
    });
  }

  /**
   * Make the accepted note a document in the wiki.
   *
   * `source = 'librarian'` is the whole distinction between the agent's notes and the
   * researcher's: the schema needed no new column, because a write is legal if and only if it
   * lands in the workspace, and that is a path question rather than a table question.
   */
  async #registerDocument(
    stored: StoredProposal,
    absolutePath: string,
    relative: string,
    markdown: string,
  ): Promise<string> {
    const existing = this.#db.files.findByPath(absolutePath);
    if (existing !== null) return existing.documentId;

    const document = this.#db.documents.create({
      title: stored.title,
      docType: 'markdown',
      source: 'librarian',
      slug: relative.replace(/\.md$/, ''),
    });
    const info = await stat(absolutePath);
    this.#db.files.upsertByPath({
      documentId: document.id,
      path: absolutePath,
      mimeType: 'text/markdown',
      byteSize: info.size,
      contentHash: createHash('sha256').update(markdown).digest('hex'),
      role: 'primary',
    });
    return document.id;
  }
}

function isCitation(value: unknown): value is Citation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'entityId') === 'string' &&
    typeof Reflect.get(value, 'entityType') === 'string'
  );
}

/**
 * The note as it lands on disk.
 *
 * `covers` is written into the front matter *and* spelled out as `[[wikilinks]]` under a
 * heading. The front matter is what a later pass routes on (`A12`); the links are what make
 * the graph real and what a person clicks.
 */
export function renderNote(
  proposal: Pick<StoredProposal, 'title' | 'kind' | 'body' | 'runId'>,
  citations: readonly Citation[],
  covers: readonly Citation[],
): string {
  const lines = [
    '---',
    `title: ${JSON.stringify(proposal.title)}`,
    `kind: ${proposal.kind}`,
    'source: librarian',
    `run: ${proposal.runId}`,
    ...(covers.length === 0
      ? []
      : [`covers: [${covers.map((citation) => citation.entityId).join(', ')}]`]),
    '---',
    '',
    `# ${proposal.title}`,
    '',
    proposal.body.trim(),
    '',
  ];
  if (covers.length > 0) {
    lines.push('## Covers', '');
    for (const citation of covers) lines.push(`- [[${citation.entityId}]] — ${citation.title}`);
    lines.push('');
  }
  const others = citations.filter(
    (citation) => !covers.some((covered) => covered.entityId === citation.entityId),
  );
  if (others.length > 0) {
    lines.push('## Also cited', '');
    for (const citation of others) lines.push(`- [[${citation.entityId}]] — ${citation.title}`);
    lines.push('');
  }
  return lines.join('\n');
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length === 0 ? 'note' : slug;
}
