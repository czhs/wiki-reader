/**
 * The librarian's system prompt, and the capabilities that make it up.
 *
 * Two rules from `docs/AGENTS.md` shape this file.
 *
 * The first is that the prompt stays short. Every sentence of instruction is a sentence of
 * judgement given up, and the model is better at deciding how to organise a wiki than we are
 * at describing it in advance. A thirty-line prompt specifying an output schema comes back
 * schema-shaped and thin; anything that must be machine-readable is validated on the way in
 * instead, at the boundary, where a schema is a guarantee rather than a request.
 *
 * The second is that the remit is **data**. Each capability is one line appended only when it
 * is enabled, so switching one off *removes* it rather than arguing against it in a longer
 * prompt. `A09` is only assertable in that form: with directions off, the line is gone, and
 * nothing downstream will accept a direction either.
 */

import { LIBRARIAN_CAPABILITY_IDS, type LibrarianCapabilityId } from '@wr/shared-types';

/**
 * The ids themselves live in `@wr/shared-types`, because the renderer offers the switches and
 * the IPC boundary validates them. What lives *here* is what each one asks the librarian to
 * do — the line, and whether the capability is core.
 */
export const LIBRARIAN_CAPABILITIES = LIBRARIAN_CAPABILITY_IDS;

export type LibrarianCapability = LibrarianCapabilityId;

interface CapabilityDefinition {
  /** The one line this capability contributes to the prompt when it is enabled. */
  readonly line: string;
  /**
   * Core capabilities are what the librarian is *for* and are not expected to move.
   * `directions` is under review: how much reach the librarian should have is genuinely
   * undecided, so it ships on and has to come off without touching anything else.
   */
  readonly core: boolean;
}

export const CAPABILITIES: Readonly<Record<LibrarianCapability, CapabilityDefinition>> = {
  connect: {
    line: 'Connect threads across it, however far apart they sit.',
    core: true,
  },
  contradict: {
    line: 'Say plainly where two sources disagree, and cite both.',
    core: true,
  },
  evidence: {
    line: 'Set out the evidence for and against a question, on both sides.',
    core: true,
  },
  directions: {
    line: 'Where the material points somewhere nobody has gone yet, say so.',
    core: false,
  },
};

/** What the librarian runs with when nothing has been switched off. */
export const DEFAULT_CAPABILITIES: readonly LibrarianCapability[] = LIBRARIAN_CAPABILITIES;

export function isLibrarianCapability(value: string): value is LibrarianCapability {
  return (LIBRARIAN_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The prompt, assembled from the paragraphs that never change plus the enabled capabilities.
 *
 * The capability lines sit together in the third paragraph, which is the one that says what
 * the work *is*. Enabling and disabling therefore changes the length of a list rather than
 * leaving a hole in an argument.
 */
export function buildLibrarianPrompt(
  enabled: readonly LibrarianCapability[] = DEFAULT_CAPABILITIES,
): string {
  const remit = LIBRARIAN_CAPABILITIES.filter((capability) => enabled.includes(capability)).map(
    (capability) => CAPABILITIES[capability].line,
  );

  return [
    'You are the librarian for a personal research wiki.',
    '',
    "The whole wiki is yours to read: the papers, the saved pages, the researcher's notes, the",
    'open questions, the journal. You write only in your own workspace — your notes, your maps,',
    'your logs. Everything else is read-only.',
    '',
    'Your work is to make what has been read into something that can be thought with.',
    ...remit,
    '',
    'Read widely and read whole documents. Connections come from holding many of them in mind at',
    'once, not from searching for the ones that look related. Crawl wherever the material leads.',
    '',
    'Leave the wiki better organised than you found it, so a later pass can hold more of it at',
    'once. Favour structure and cross-links over summary: a summary that drops the detail two',
    'papers disagree about has lost the useful part. Say which documents each note covers. If a',
    'pass turns up nothing worth recording, record nothing.',
    '',
    'Cite everything. A claim without a source is worse than a missing claim.',
    '',
    'Organise your workspace however serves someone trying to make progress. Use [[wikilinks]] so',
    'the graph is real.',
    '',
  ].join('\n');
}
