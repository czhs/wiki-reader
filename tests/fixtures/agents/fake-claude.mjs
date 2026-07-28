#!/usr/bin/env node
/**
 * A `claude` that replays a recording instead of calling a model.
 *
 * The runner spawns this as a real child process, so everything under test is real except the
 * model's tokens: the argv, the working directory, the pipe, the chunk boundaries, the exit
 * code and the process lifecycle. What it replays is a genuine `--output-format stream-json`
 * transcript — see `README.md` in this directory.
 *
 * It does four things:
 *
 * 1. writes the argv and cwd it was given to `spawn-argv.json`, so a test can assert what the
 *    runner actually spawned rather than trusting that it spawned it;
 * 2. streams the recording in chunks that deliberately fall in the middle of lines, because a
 *    pipe splits wherever it likes and one recorded event is 20 kB of file content;
 * 3. materialises the files the recorded run wrote, so the run leaves behind the artifacts the
 *    transcript says it left behind.
 * 4. optionally waits, mid-stream, for the consumer to react — the handshake below.
 * 5. optionally writes its findings where the task says to, and optionally tries to write
 *    where it has been told it may not — see the last two environment variables.
 *
 * ## Writing like an agent, and escaping like one
 *
 * `AgentWorkspace` bounds the writes the *app* makes. It is not what bounds the spawned
 * `claude`, which writes with its own tools and never calls it; that is its working directory
 * plus a `--add-dir` tree the app has already sealed read-only. Those are different doors, and
 * a test that only opens the first proves nothing about the second — so `WR_FAKE_CLAUDE_ESCAPE`
 * makes this child do what a misbehaving agent would, and records what the kernel said.
 *
 * `WR_FAKE_CLAUDE_PROPOSALS` is the other half: findings written to `./proposals/`, which is
 * where the task tells the agent to put them, rather than staged into the run directory by a
 * test that computed the path itself. That is the seam between what an agent writes and what
 * the harvester reads, and it is the one that has actually been broken.
 *
 * ## The handshake
 *
 * `A01` says progress arrives *while the run is in flight*, and the arrival order of a set of
 * events cannot show that: a runner that swallowed every chunk and replayed the lot after the
 * process closed produces exactly the same list, in exactly the same order. The only witness to
 * liveness is the child itself. So with `WR_FAKE_CLAUDE_LIVE_ACK` set, this pauses after its
 * fourth chunk — by which point the recording's `init` line is over the pipe — and waits for
 * that file to appear. The test writes it from the runner's event callback. What lands in
 * `live-handshake.json` is therefore an answer to "did an event reach the consumer *before*
 * this process finished writing", with the bytes still owed as the proof it had not.
 *
 * Environment:
 *   WR_FAKE_CLAUDE_STREAM    path to the transcript (default: the recording beside this file)
 *   WR_FAKE_CLAUDE_EXIT      exit code (default 0)
 *   WR_FAKE_CLAUDE_STDERR    text to write to stderr before exiting
 *   WR_FAKE_CLAUDE_LIVE_ACK  path the consumer touches on its first event; enables the handshake
 *   WR_FAKE_CLAUDE_QUIET     replay the transcript but write none of its files
 *   WR_FAKE_CLAUDE_PROPOSALS directory of .md findings to write into ./proposals/
 *   WR_FAKE_CLAUDE_ESCAPE    set to attempt a write into each --add-dir root and record the result
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const streamPath = process.env.WR_FAKE_CLAUDE_STREAM ?? join(here, 'librarian-stream.jsonl');
const exitCode = Number(process.env.WR_FAKE_CLAUDE_EXIT ?? '0');

writeFileSync(
  join(process.cwd(), 'spawn-argv.json'),
  JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }, null, 2),
  'utf8',
);

const transcript = readFileSync(streamPath, 'utf8');

// Replay the writes the recorded run made, into this run's directory. The recording's paths
// belong to the machine it was recorded on, so only the file name is reused.
//
// `WR_FAKE_CLAUDE_QUIET` skips them, which is the pass the task's last line describes: "if
// this pass turns up nothing worth recording, write nothing". Without it a test for that
// cannot tell a quiet pass from a pass whose output landed somewhere nobody reads.
for (const line of process.env.WR_FAKE_CLAUDE_QUIET ? [] : transcript.split('\n')) {
  if (line.trim().length === 0) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.type !== 'assistant') continue;
  const blocks = event.message?.content;
  if (!Array.isArray(blocks)) continue;
  for (const block of blocks) {
    if (block.type !== 'tool_use' || block.name !== 'Write') continue;
    const target = join(process.cwd(), basename(String(block.input?.file_path ?? 'note.md')));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, String(block.input?.content ?? ''), 'utf8');
  }
}

// What the task asks for: one markdown file per finding in `./proposals/`, relative to the
// working directory the runner put this process in. The path is built the way an agent
// reading that instruction would build it, not the way a test computing `.runs/<id>` would.
const proposalSource = process.env.WR_FAKE_CLAUDE_PROPOSALS;
if (proposalSource !== undefined) {
  const directory = join(process.cwd(), 'proposals');
  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(proposalSource).filter((entry) => entry.endsWith('.md'))) {
    writeFileSync(join(directory, name), readFileSync(join(proposalSource, name), 'utf8'), 'utf8');
  }
}

// Try to write where the app said this process may only read. Every `--add-dir` root is a
// tree the app sealed before the spawn, so each of these should be refused by the filesystem
// itself rather than by anything the agent chose to respect.
if (process.env.WR_FAKE_CLAUDE_ESCAPE) {
  const argv = process.argv.slice(2);
  const attempts = [];
  for (const [index, argument] of argv.entries()) {
    if (argument !== '--add-dir') continue;
    const root = argv[index + 1];
    if (root === undefined) continue;
    for (const target of [join(root, 'escape.md'), join(root, 'documents', 'escape.md')]) {
      try {
        writeFileSync(target, 'the agent was here\n', 'utf8');
        attempts.push({ target, wrote: true, code: null });
      } catch (error) {
        attempts.push({ target, wrote: false, code: error.code ?? String(error) });
      }
    }
  }
  writeFileSync(
    join(process.cwd(), 'escape-attempts.json'),
    JSON.stringify(attempts, null, 2),
    'utf8',
  );
}

const CHUNK = 3000;
const ackPath = process.env.WR_FAKE_CLAUDE_LIVE_ACK;
// The recording's first two lines are hook records, which become no event at all; the `init`
// line that becomes one ends inside the fourth chunk. Pausing earlier would ask the consumer
// to react to something it was never handed.
const PAUSE_AFTER_CHUNKS = 4;
const ACK_TIMEOUT_MS = 5000;

/** Resolve once the chunk has actually reached the pipe, not merely been queued. */
const write = (text) => new Promise((resolve) => process.stdout.write(text, () => resolve()));

async function waitForAck() {
  const deadline = Date.now() + ACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(ackPath)) return true;
    // Polling on a timer rather than blocking: a synchronous wait would hold the event loop
    // and stop the chunks already written from ever leaving this process.
    await sleep(10);
  }
  return false;
}

for (let offset = 0, index = 0; offset < transcript.length; offset += CHUNK, index += 1) {
  await write(transcript.slice(offset, offset + CHUNK));
  if (ackPath === undefined || index !== PAUSE_AFTER_CHUNKS - 1) continue;

  const written = Math.min(offset + CHUNK, transcript.length);
  writeFileSync(
    join(process.cwd(), 'live-handshake.json'),
    JSON.stringify(
      { acknowledged: await waitForAck(), writtenBytes: written, owedBytes: transcript.length - written },
      null,
      2,
    ),
    'utf8',
  );
}

if (process.env.WR_FAKE_CLAUDE_STDERR) process.stderr.write(process.env.WR_FAKE_CLAUDE_STDERR);

process.stdout.end(() => process.exit(exitCode));
