/**
 * What the `agent:progress` topic is allowed to say (audit finding 1).
 *
 * `CLAUDE.md` and `docs/SECURITY.md` both say the renderer never receives a filesystem path.
 * The librarian's transcript is made of them: Claude Code's `Read` takes an *absolute*
 * `file_path`, and the model narrates its own working directory in prose. `agentProgress` is
 * the single function that turns a stream event into the payload that leaves the main
 * process, so it is where that invariant is kept or lost.
 *
 * The fixture is the proof of shape — a real recorded run, not an invented one.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentProgress } from '../../apps/desktop/src/main/services.js';
import { parseStreamLine } from '../../apps/desktop/src/main/agents/stream.js';

const RUN_ID = 'agr_01hqzt5m8k9x2n4p6r8s0t2v4w';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'agents');

/** Any whitespace-delimited token that begins at the filesystem root. */
const ABSOLUTE = /(?:^|[\s`'"(])\/[^\s`'")]+/;

describe('the progress topic', () => {
  it('renders a read inside the wiki as a path relative to it', () => {
    const payload = agentProgress(
      RUN_ID,
      { kind: 'tool', tool: 'Read', target: '/tmp/wr-fix/wiki/documents/doc_a.md' },
      ['/tmp/wr-fix/wiki'],
    );

    expect(payload.detail).toBe('Read documents/doc_a.md');
  });

  it('reduces a path outside every root to its basename, keeping no directory', () => {
    const payload = agentProgress(
      RUN_ID,
      { kind: 'tool', tool: 'Read', target: '/Users/someone/Zotero/storage/ABCD/paper.pdf' },
      ['/tmp/wr-fix/wiki'],
    );

    expect(payload.detail).toBe('Read paper.pdf');
    expect(payload.detail).not.toContain('someone');
  });

  it('scrubs a path the model narrates in prose', () => {
    const payload = agentProgress(
      RUN_ID,
      { kind: 'message', text: 'Current working directory is `/private/tmp/wr-fix/run`.' },
      ['/tmp/wr-fix/wiki'],
    );

    expect(payload.detail).not.toMatch(ABSOLUTE);
    expect(payload.detail).toContain('run');
  });

  it('leaves an already-relative target alone', () => {
    const payload = agentProgress(
      RUN_ID,
      { kind: 'tool', tool: 'Write', target: 'proposals/connection-1.md' },
      ['/tmp/wr-fix/wiki'],
    );

    expect(payload.detail).toBe('Write proposals/connection-1.md');
  });

  it('emits no absolute path anywhere in a real recorded run', () => {
    const transcript = readFileSync(join(FIXTURES, 'librarian-stream.jsonl'), 'utf8');
    const roots = ['/tmp/wr-fix/wiki'];

    const details = transcript
      .split('\n')
      .flatMap((line) => parseStreamLine(line))
      .map((event) => agentProgress(RUN_ID, event, roots).detail);

    expect(details.length).toBeGreaterThan(10);
    const leaking = details.filter((detail) => ABSOLUTE.test(detail));
    expect(leaking).toEqual([]);
  });
});
