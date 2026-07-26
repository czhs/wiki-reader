#!/usr/bin/env node
/**
 * A `claude` that replays a recording instead of calling a model.
 *
 * The runner spawns this as a real child process, so everything under test is real except the
 * model's tokens: the argv, the working directory, the pipe, the chunk boundaries, the exit
 * code and the process lifecycle. What it replays is a genuine `--output-format stream-json`
 * transcript — see `README.md` in this directory.
 *
 * It does three things:
 *
 * 1. writes the argv and cwd it was given to `spawn-argv.json`, so a test can assert what the
 *    runner actually spawned rather than trusting that it spawned it;
 * 2. streams the recording in chunks that deliberately fall in the middle of lines, because a
 *    pipe splits wherever it likes and one recorded event is 20 kB of file content;
 * 3. materialises the files the recorded run wrote, so the run leaves behind the artifacts the
 *    transcript says it left behind.
 *
 * Environment:
 *   WR_FAKE_CLAUDE_STREAM  path to the transcript (default: the recording beside this file)
 *   WR_FAKE_CLAUDE_EXIT    exit code (default 0)
 *   WR_FAKE_CLAUDE_STDERR  text to write to stderr before exiting
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
for (const line of transcript.split('\n')) {
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

const CHUNK = 3000;
for (let offset = 0; offset < transcript.length; offset += CHUNK) {
  process.stdout.write(transcript.slice(offset, offset + CHUNK));
}

if (process.env.WR_FAKE_CLAUDE_STDERR) process.stderr.write(process.env.WR_FAKE_CLAUDE_STDERR);

process.stdout.end(() => process.exit(exitCode));
