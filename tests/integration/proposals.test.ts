/**
 * The proposal boundary (criteria A04, A06, A07, A08, A09, A12).
 *
 * Everything the criteria promise about a proposal is decided on the way *in*, which is the
 * only place it can be guaranteed. An agent asked for citations will produce citation-shaped
 * text whether or not the documents exist; an agent told a capability is off will mostly
 * comply, and "mostly" is not a boundary. So each case below stages a file that a well-behaved
 * run would never write, and asserts it does not survive.
 *
 * The staged files go through `AgentWorkspace`, which is how a run writes them, so the path
 * under test is the real one rather than a fixture dropped into place beside it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServices, type AppServices } from '../../apps/desktop/src/main/services.js';
import { createLogger, silentLogger, type Logger } from '../../apps/desktop/src/main/logger.js';
import { AgentWorkspace } from '../../apps/desktop/src/main/agents/workspace.js';
import { ProposalReader } from '../../apps/desktop/src/main/agents/proposals.js';
import { DEFAULT_CAPABILITIES } from '../../apps/desktop/src/main/agents/prompt.js';

const RUN = 'run-proposals';

describe('what a run may hand back', () => {
  let dir: string;
  let services: AppServices;
  let workspace: AgentWorkspace;
  let reader: ProposalReader;
  let records: Array<{ event: string; reason?: string; detail?: string }>;
  let logger: Logger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wr-proposals-'));
    services = createTestServices({
      databasePath: join(dir, 'wiki-reader.db'),
      zoteroDataDir: join(dir, 'zotero'),
      logger: silentLogger,
    });
    records = [];
    logger = createLogger({
      level: 'debug',
      sink: (line) => records.push(JSON.parse(line) as { event: string }),
    });
    workspace = new AgentWorkspace({ root: join(dir, 'librarian'), logger });
    reader = new ProposalReader({ workspace, db: services.db, logger });
    await workspace.runDirectory(RUN);
  });

  afterEach(() => {
    services.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const paper = (title: string): string =>
    services.db.documents.create({ title, docType: 'pdf', source: 'zotero' }).id;

  const stage = async (name: string, contents: string): Promise<void> => {
    await workspace.writeOrThrow(join('.runs', RUN, 'proposals', name), contents);
  };

  const refusals = (): Array<{ reason?: string; detail?: string }> =>
    records.filter((record) => record.event.endsWith('proposal refused'));

  // --- A04 -----------------------------------------------------------------

  it('[A04] resolves every cited id against the database', async () => {
    const a = paper('Scaling monosemanticity');
    const b = paper('Feature splitting is an artefact');

    await stage(
      'connection.md',
      `---\nkind: connection\ntitle: Two readings of feature splitting\nthreads: [${a}, ${b}]\n---\n\nBoth [[${a}]] and [[${b}]] describe the same sweep.\n`,
    );

    const harvest = await reader.harvest(RUN, DEFAULT_CAPABILITIES);

    expect(harvest.proposals).toHaveLength(1);
    const proposal = harvest.proposals[0];
    expect(proposal?.citations.map((citation) => citation.entityId).sort()).toEqual([a, b].sort());
    // Resolved, not merely echoed: the title came out of the database.
    expect(proposal?.citations.map((citation) => citation.title)).toContain(
      'Scaling monosemanticity',
    );
  });

  it('[A04] refuses a proposal whose citation names a document that is not in the wiki', async () => {
    const real = paper('Scaling monosemanticity');
    // Well-formed and utterly plausible, and nothing in the database. This is what a
    // hallucinated citation looks like — the shape is never the problem.
    const invented = 'doc_01hzzzzzzzzzzzzzzzzzzzzzzz';

    await stage(
      'connection.md',
      `---\nkind: connection\ntitle: A connection to nowhere\nthreads: [${real}, ${invented}]\n---\n\n[[${real}]] and [[${invented}]] agree.\n`,
    );

    const harvest = await reader.harvest(RUN, DEFAULT_CAPABILITIES);

    expect(harvest.proposals).toHaveLength(0);
    expect(harvest.rejected[0]?.reason).toBe('unresolved-citation');
    expect(harvest.rejected[0]?.detail).toBe(invented);
    expect(refusals()).toHaveLength(1);
  });

  it('[A04] refuses the whole proposal, not just the citation that failed', async () => {
    const real = paper('Real paper');
    await stage(
      'mixed.md',
      `---\nkind: connection\ntitle: Half true\nthreads: [${real}, doc_01hzzzzzzzzzzzzzzzzzzzzzzz]\n---\n\nBody mentioning [[${real}]].\n`,
    );

    const harvest = await reader.harvest(RUN, DEFAULT_CAPABILITIES);

    // A note asserting a source that is not there is worse than no note, so there is no
    // partial form of this: the proposal does not survive with one thread.
    expect(harvest.proposals).toHaveLength(0);
  });

  it('[A04] resolves a citation written only as a wikilink in the prose', async () => {
    const a = paper('First');
    const b = paper('Second');
    const ghost = 'doc_01hzzzzzzzzzzzzzzzzzzzzzzz';

    await stage(
      'prose.md',
      `---\nkind: connection\ntitle: Cited in prose\nthreads: [${a}, ${b}]\n---\n\nAs [[${ghost}]] also argues.\n`,
    );

    expect((await reader.harvest(RUN, DEFAULT_CAPABILITIES)).proposals).toHaveLength(0);
  });

  // --- A06 -----------------------------------------------------------------

  it('[A06] keeps both threads a connection joins, and the reason it joins them', async () => {
    const a = paper('Sparse autoencoders');
    const question = services.db.questions.create({ title: 'Does splitting bottom out?' }).id;

    await stage(
      'connection.md',
      `---\nkind: connection\ntitle: A paper bearing on an open question\nthreads: [${a}, ${question}]\n---\n\nThe width sweep in [[${a}]] is the experiment [[${question}]] is waiting on.\n`,
    );

    const proposal = (await reader.harvest(RUN, DEFAULT_CAPABILITIES)).proposals[0];

    expect(proposal?.threads).toHaveLength(2);
    expect(proposal?.threads.map((thread) => thread.entityType).sort()).toEqual([
      'document',
      'question',
    ]);
    // "and why": the body is the reason, and a connection without one is not one.
    expect(proposal?.body).toContain('waiting on');
  });

  it('[A06] refuses a connection that names only one thread', async () => {
    const a = paper('Alone');
    await stage(
      'lonely.md',
      `---\nkind: connection\ntitle: A connection to itself\nthreads: [${a}]\n---\n\nInteresting on its own.\n`,
    );

    const harvest = await reader.harvest(RUN, DEFAULT_CAPABILITIES);
    expect(harvest.proposals).toHaveLength(0);
    expect(harvest.rejected[0]?.reason).toBe('missing-threads');
  });

  it('[A06] refuses a connection whose two threads are the same document twice', async () => {
    const a = paper('Twice');
    await stage(
      'doubled.md',
      `---\nkind: connection\ntitle: Doubled\nthreads: [${a}, ${a}]\n---\n\nA connection needs two ends.\n`,
    );

    expect((await reader.harvest(RUN, DEFAULT_CAPABILITIES)).proposals).toHaveLength(0);
  });

  // --- A07 -----------------------------------------------------------------

  it('[A07] keeps both sides of a contradiction, each resolving', async () => {
    const a = paper('No ceiling to feature splitting');
    const b = paper('Splitting is an artefact of the sweep');

    await stage(
      'contradiction.md',
      `---\nkind: contradiction\ntitle: Is feature splitting real structure?\nsides: [${a}, ${b}]\n---\n\n[[${a}]] finds no ceiling; [[${b}]] says past the true feature count the splits are spurious.\n`,
    );

    const proposal = (await reader.harvest(RUN, DEFAULT_CAPABILITIES)).proposals[0];

    expect(proposal?.kind).toBe('contradiction');
    expect(proposal?.sides).toHaveLength(2);
    expect(proposal?.sides.every((side) => side.documentId !== null)).toBe(true);
  });

  it('[A07] refuses a contradiction that cites only one side', async () => {
    const a = paper('One-sided');
    await stage(
      'one-sided.md',
      `---\nkind: contradiction\ntitle: A disagreement with nobody\nsides: [${a}]\n---\n\nThis paper is wrong.\n`,
    );

    const harvest = await reader.harvest(RUN, DEFAULT_CAPABILITIES);
    expect(harvest.proposals).toHaveLength(0);
    expect(harvest.rejected[0]?.reason).toBe('missing-sides');
  });

  // --- A08 -----------------------------------------------------------------

  it('[A08] surfaces evidence for a question on both sides, each cited', async () => {
    const question = services.db.questions.create({ title: 'Do wider dictionaries help?' }).id;
    const forIt = paper('Wider dictionaries keep splitting features');
    const against = paper('Width past the true count produces artefacts');

    await stage(
      'evidence.md',
      `---\nkind: evidence\ntitle: Evidence on dictionary width\nquestion: ${question}\nsupports: [${forIt}]\nopposes: [${against}]\n---\n\nFor: [[${forIt}]]. Against: [[${against}]].\n`,
    );

    const proposal = (await reader.harvest(RUN, DEFAULT_CAPABILITIES)).proposals[0];

    expect(proposal?.question?.entityId).toBe(question);
    expect(proposal?.supporting.map((citation) => citation.entityId)).toEqual([forIt]);
    expect(proposal?.opposing.map((citation) => citation.entityId)).toEqual([against]);
  });

  it('[A08] refuses evidence that is only one-sided', async () => {
    const question = services.db.questions.create({ title: 'Only good news?' }).id;
    const forIt = paper('Everything works');

    await stage(
      'one-way.md',
      `---\nkind: evidence\ntitle: All in favour\nquestion: ${question}\nsupports: [${forIt}]\n---\n\nNothing to say against it.\n`,
    );

    const harvest = await reader.harvest(RUN, DEFAULT_CAPABILITIES);
    expect(harvest.proposals).toHaveLength(0);
    expect(harvest.rejected[0]?.reason).toBe('missing-evidence');
    expect(harvest.rejected[0]?.detail).toContain('0 against');
  });

  it('[A08] refuses evidence attached to something that is not a question', async () => {
    const notAQuestion = paper('A paper, not a question');
    const forIt = paper('For');
    const against = paper('Against');

    await stage(
      'wrong-target.md',
      `---\nkind: evidence\ntitle: Evidence about a paper\nquestion: ${notAQuestion}\nsupports: [${forIt}]\nopposes: [${against}]\n---\n\nBody.\n`,
    );

    expect((await reader.harvest(RUN, DEFAULT_CAPABILITIES)).proposals).toHaveLength(0);
  });

  // --- A09 -----------------------------------------------------------------

  it('[A09] produces no research directions once the capability is switched off', async () => {
    const a = paper('A paper');
    // The run wrote one anyway. That is exactly the case the flag exists to survive: the
    // prompt line is a request, and the boundary is the guarantee.
    await stage(
      'direction.md',
      `---\nkind: direction\ntitle: Try a width sweep on a larger model\n---\n\nNobody has run this on [[${a}]]'s setup at scale.\n`,
    );
    await stage(
      'connection.md',
      `---\nkind: connection\ntitle: Still allowed\nthreads: [${a}, ${paper('Another')}]\n---\n\nThese two share a method.\n`,
    );

    const harvest = await reader.harvest(RUN, ['connect', 'contradict', 'evidence']);

    expect(harvest.proposals.map((proposal) => proposal.kind)).toEqual(['connection']);
    expect(harvest.rejected.map((rejection) => rejection.reason)).toEqual(['capability-off']);
    expect(refusals()[0]?.detail).toBe('directions');
  });

  it('[A09] keeps directions when the capability is on, so the switch is what decides', async () => {
    const a = paper('A paper');
    await stage(
      'direction.md',
      `---\nkind: direction\ntitle: Try a width sweep on a larger model\n---\n\nNobody has run this on [[${a}]]'s setup at scale.\n`,
    );

    const harvest = await reader.harvest(RUN, DEFAULT_CAPABILITIES);
    expect(harvest.proposals.map((proposal) => proposal.kind)).toEqual(['direction']);
  });

  // --- A12 -----------------------------------------------------------------

  it('[A12] records which documents a note covers, and every one of them resolves', async () => {
    const a = paper('First paper');
    const b = paper('Second paper');
    const c = paper('Third paper');

    await stage(
      'map.md',
      `---\nkind: connection\ntitle: A map of the width-sweep literature\nthreads: [${a}, ${b}]\ncovers: [${a}, ${b}, ${c}]\n---\n\nThe sweep runs through [[${a}]], [[${b}]] and [[${c}]].\n`,
    );

    const proposal = (await reader.harvest(RUN, DEFAULT_CAPABILITIES)).proposals[0];

    expect(proposal?.covers.map((citation) => citation.entityId).sort()).toEqual(
      [a, b, c].sort(),
    );
    // Resolving is the half that can fail silently: a list of ids is not a list of documents.
    for (const covered of proposal?.covers ?? []) {
      expect(services.db.documents.getById(covered.entityId)?.id).toBe(covered.entityId);
    }
  });

  it('[A12] falls back to the documents a note cites when it declares no coverage', async () => {
    const a = paper('First');
    const b = paper('Second');
    const question = services.db.questions.create({ title: 'A question' }).id;

    await stage(
      'undeclared.md',
      `---\nkind: connection\ntitle: Undeclared coverage\nthreads: [${a}, ${question}]\n---\n\nAlso mentions [[${b}]].\n`,
    );

    const proposal = (await reader.harvest(RUN, DEFAULT_CAPABILITIES)).proposals[0];

    // Documents only: a question is a thread the note joins, not a source it covers.
    expect(proposal?.covers.map((citation) => citation.entityId).sort()).toEqual([a, b].sort());
  });

  // --- A13's second half, asserted from this side --------------------------

  it('[A13] returns nothing at all for a run that staged nothing', async () => {
    const harvest = await reader.harvest(RUN, DEFAULT_CAPABILITIES);
    expect(harvest.proposals).toEqual([]);
    expect(harvest.rejected).toEqual([]);
  });
});
