# Recorded agent fixtures

`librarian-stream.jsonl` is a real `--output-format stream-json` transcript, recorded from
Claude Code 2.1.220 on 2026-07-26. It was produced by the librarian's own system prompt run
against a two-document corpus written so the documents contradict each other:

```
claude --system-prompt-file <the librarian prompt> --add-dir <corpus> \
       --permission-mode acceptEdits --output-format stream-json --verbose \
       --tools "Read,Glob,Grep,Write" -p "<crawl and write a note>"
```

The run found the contradiction, cited both documents with `[[wikilinks]]`, and wrote one note
into its working directory — which is the behaviour `A06`–`A08` describe.

It is recorded rather than written by hand because the value of the file is that the envelope
shapes are the CLI's and not our guess at them. It carries every event kind the runner has to
survive: `system/init`, `system/thinking_tokens`, `system/hook_started`, `assistant` messages
holding `thinking`, `tool_use` and `text` blocks, `user` messages holding `tool_result`,
`rate_limit_event`, and the terminal `result/success`.

Two mechanical redactions were made and nothing else:

- paths under the recording machine's home directory became `/Users/researcher/…`;
- the `init` event's `slash_commands`, `skills` and `plugins` inventories were emptied. They
  describe the laptop it was recorded on rather than the stream contract, and they do not
  belong in a committed file.

`tests/fixtures/agents/fake-claude.mjs` replays it. The runner spawns that script as a real
child process, so the pipe, the line splitting and the process lifecycle under test are the
real ones; only the model's tokens are a recording.
