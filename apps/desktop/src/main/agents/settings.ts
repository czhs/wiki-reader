/**
 * Whether the librarian may run, and what it would send if it did.
 *
 * Agents are the only exception to local-first, so the switch and the disclosure are one
 * module: enabling is refused unless the disclosure has been acknowledged, and the
 * acknowledgement is stored with a timestamp rather than assumed from a click somewhere in the
 * renderer. `A03` is about the order — the disclosure comes *first* — and an order that lives
 * only in a component is one re-arrangement away from being untrue.
 *
 * The disclosure is computed from the database, not written as prose in a component. What a
 * run sends is exactly what `WikiView.materialise` writes out, so the counts here are the
 * counts it would produce; a sentence that said "your notes" while the view also wrote the
 * journal would be a false statement of the same kind as no disclosure at all.
 */
import { z } from 'zod';
import type { WikiReaderDatabase } from '@wr/database';
import type { AgentDisclosure } from '@wr/shared-types';
import {
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  isLibrarianCapability,
  LIBRARIAN_CAPABILITIES,
  type LibrarianCapability,
} from './prompt.js';
import { CRAWL_TOOLS } from './runner.js';

/** One settings key, one JSON object: the switch and its capabilities move together. */
export const AGENT_SETTINGS_KEY = 'agents.librarian';

const StoredAgentSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  capabilities: z.array(z.string()).default([...DEFAULT_CAPABILITIES]),
  /** When the disclosure was read and accepted. Null until it has been. */
  disclosureAcknowledgedAt: z.string().nullable().default(null),
});

export interface AgentSettings {
  readonly enabled: boolean;
  readonly capabilities: readonly LibrarianCapability[];
  readonly disclosureAcknowledgedAt: string | null;
}

/** Off, with every capability armed for the day somebody turns it on. */
export function defaultAgentSettings(): AgentSettings {
  return {
    enabled: false,
    capabilities: [...DEFAULT_CAPABILITIES],
    disclosureAcknowledgedAt: null,
  };
}

export function readAgentSettings(db: WikiReaderDatabase): AgentSettings {
  const parsed = StoredAgentSettingsSchema.safeParse(db.settings.get(AGENT_SETTINGS_KEY));
  if (!parsed.success) return defaultAgentSettings();
  return {
    enabled: parsed.data.enabled,
    // Filtered rather than trusted: a capability that no longer exists must not survive in
    // the stored list and reappear in a prompt as an unknown line.
    capabilities: parsed.data.capabilities.filter(isLibrarianCapability),
    disclosureAcknowledgedAt: parsed.data.disclosureAcknowledgedAt,
  };
}

export function writeAgentSettings(
  db: WikiReaderDatabase,
  patch: Partial<AgentSettings>,
): AgentSettings {
  const current = readAgentSettings(db);
  const next: AgentSettings = {
    enabled: patch.enabled ?? current.enabled,
    capabilities: (patch.capabilities ?? current.capabilities).filter(isLibrarianCapability),
    disclosureAcknowledgedAt:
      patch.disclosureAcknowledgedAt === undefined
        ? current.disclosureAcknowledgedAt
        : patch.disclosureAcknowledgedAt,
  };
  db.settings.set(AGENT_SETTINGS_KEY, {
    enabled: next.enabled,
    capabilities: [...next.capabilities],
    disclosureAcknowledgedAt: next.disclosureAcknowledgedAt,
  });
  return next;
}

/** Raised when something tries to switch agents on without the disclosure being accepted. */
export class DisclosureNotAcknowledgedError extends Error {
  constructor() {
    super('The disclosure has to be read before agents can be enabled.');
    this.name = 'DisclosureNotAcknowledgedError';
  }
}

/**
 * Turn agents on or off.
 *
 * Turning them *on* requires the disclosure, either acknowledged now or acknowledged before.
 * Turning them off never does — a switch you cannot reach without a ceremony is a switch
 * people leave on.
 */
export function setAgentsEnabled(
  db: WikiReaderDatabase,
  input: { readonly enabled: boolean; readonly acknowledgeDisclosure?: boolean },
  now: string,
): AgentSettings {
  const current = readAgentSettings(db);
  if (!input.enabled) return writeAgentSettings(db, { enabled: false });

  const acknowledgedAt =
    input.acknowledgeDisclosure === true ? now : current.disclosureAcknowledgedAt;
  if (acknowledgedAt === null) throw new DisclosureNotAcknowledgedError();
  return writeAgentSettings(db, { enabled: true, disclosureAcknowledgedAt: acknowledgedAt });
}

// ---------------------------------------------------------------------------
// The disclosure
// ---------------------------------------------------------------------------

/**
 * What a run would send, counted from the wiki as it stands right now.
 *
 * Every entry corresponds to something `WikiView.materialise` writes into the directory the
 * agent is handed. The document line says "full text" because that is the point of the design
 * — whole documents, no retrieval — and it is also the part a person most needs told.
 */
export function agentDisclosure(
  db: WikiReaderDatabase,
  settings: AgentSettings = readAgentSettings(db),
  executable = 'claude',
): AgentDisclosure {
  return {
    agent: 'librarian',
    headline:
      'The librarian reads your whole wiki and sends it to a model. Nothing leaves this machine until you turn it on.',
    destination: `Anthropic's API, through the \`${executable}\` command-line tool installed on this machine.`,
    credentials:
      'Your own Claude credentials, as the `claude` tool already holds them. This app never sees or stores them.',
    sends: [
      { what: 'documents, with their full extracted text', count: db.documents.count() },
      { what: 'highlights, with your comments on them', count: db.annotations.count() },
      { what: 'notebooks, with their next actions', count: db.questions.list().length },
      { what: 'journal entries', count: db.journal.listAll().length },
      { what: 'your own notes', count: db.notes.list(1).total },
    ],
    withholds: [
      'The original files. Only the text already extracted for search is written out.',
      'Everything, while agents are off: no run is scheduled and no wiki copy is made.',
      'Anything the agent might have fetched: it is given no web tool and no MCP server.',
    ],
    tools: [...CRAWL_TOOLS],
    capabilities: LIBRARIAN_CAPABILITIES.map((capability) => ({
      id: capability,
      line: CAPABILITIES[capability].line,
      core: CAPABILITIES[capability].core,
      enabled: settings.capabilities.includes(capability),
    })),
    acknowledged: settings.disclosureAcknowledgedAt !== null,
  };
}
