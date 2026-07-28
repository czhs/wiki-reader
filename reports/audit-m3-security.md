# Audit — milestone 3, security and architecture invariants

Scope: the librarian agent surface added in milestone 3 — `apps/desktop/src/main/agents/*`,
the IPC router and handlers, `protocol.ts`, `paths.ts`, `services.ts`, and the renderer panel
that drives them. Read-only audit of `main` at `f6fbede`. Lens: falsify "milestone 3 is
complete and safe".

Excluded by instruction: the known `[A01]` buffering issue, already being fixed.

---

## 1. A03 — "agents are off until enabled"

### The question

With agents disabled in settings, is there any path from a fresh launch to `materialise()`, a
child-process spawn, `scheduler.start()`, or network access? And is `<agentRoot>/wiki` on disk
the only observable, i.e. could something spawn while still not creating that directory?

### The trace

Every caller, followed to the root:

| Effect | Only reachable from | Gate |
|---|---|---|
| `LibrarianRunner.run` (the spawn) | `LibrarianService.pass`, `librarian.ts:95` | — |
| `WikiView.materialise` | `LibrarianService.pass`, `librarian.ts:94` | — |
| `LibrarianService.pass` | `handlers.ts:731` (`agent:run`) | `settings.enabled`, `handlers.ts:719-727` |
| | `services.ts:281-284` (`scheduler.startPass`) | see below |
| `scheduler.startPass` | `LibrarianScheduler.tick`, `schedule.ts:121` | `decidePass(...).due` |
| `decidePass` | `schedule.ts:50` | `if (!input.enabled) return { due: false, reason: 'disabled' }`, `schedule.ts:51` |
| `LibrarianScheduler.tick` | the interval armed in `start()`, `schedule.ts:103` | — |
| `scheduler.start()` | `startIfEnabled`, `services.ts:296-300` | `readAgentSettings(db).enabled` |
| | `handlers.ts:704` | `settings.enabled`, after `setAgentsEnabled` |
| `setAgentsEnabled(enabled: true)` | `settings.ts:100-112` | throws `DisclosureNotAcknowledgedError` when `disclosureAcknowledgedAt === null` |

`index.ts:239` is the only startup call, and it is `startIfEnabled()`. Nothing above that line
touches agents (`index.ts:236-238` says so and is correct). Construction in
`createAgentServices` (`services.ts:246-302`) is genuinely inert: `AgentWorkspace` resolves its
root lazily in `ensure()` (`workspace.ts:77-83`), `WikiView` only stores a path
(`wiki-view.ts:56-61`), `LibrarianRunner` only stores a closure, `LibrarianScheduler` arms no
timer until `start()`.

Network, separately: the only outbound primitives in first-party source are
`packages/zotero-adapter/src/client.ts:89` (`DEFAULT_ZOTERO_ENDPOINT =
'http://127.0.0.1:23119'`, `client.ts:24`) and the `fetch(fileUrl)` calls in
`html-reader`/`markdown-reader`, which fetch `rrfile://`. `lockDownNavigation`
(`protocol.ts:443-448`) cancels every `http(s)`/`ws(s)` request that is not loopback. There is
no path to a remote host with agents off.

**Verdict: genuinely safe.** The switch is double-gated (`decidePass` refuses *and* the timer is
never armed), and enabling is gated on the disclosure at the channel, not in the component.

### But the E2E's observable is sound only by accident of ordering

`tests/e2e/librarian.spec.ts:78` asserts `existsSync(join(workspace.agentRoot, 'wiki')) === false`.
That does catch a spawn today, but only because `pass()` happens to call `view.materialise()`
(`librarian.ts:94`) *before* `runner.run()` (`librarian.ts:95`). Nothing enforces that order.
Reorder those two lines and the E2E stays green while a `claude` spawns on a fresh install.
The thing to assert is the spawn itself — an `AgentSpawn` injected for the disabled case that
throws, or a counter. Recorded as **finding 14**.

### Two small notes from the same trace

- `agent:accept`, `agent:reject` and `agent:listProposals` have no `enabled` check
  (`handlers.ts:745-769`). Deciding proposals that were already pending while the switch is off
  is a defensible design (you can still triage), and accepting writes only into the workspace.
  Not a finding.
- `agent:cancel` (`handlers.ts:743`) is unguarded but only reaches `#active`, a map that is
  empty when nothing is running. Not a finding.

---

## 2. `agent:accept` — the one channel that writes a file and mints a document

### Path traversal

The renderer's entire influence over this channel is `proposalId`, constrained by
`AgentProposalIdSchema` (`ipc.ts:687-690`). The written path is not derived from renderer input
at all:

```
librarian.ts:139   join('notes', `${slugify(stored.title)}-${stored.id.slice(-6)}.md`)
librarian.ts:275   slugify: toLowerCase → replace(/[^a-z0-9]+/g,'-') → trim dashes → slice(0,60)
                   → 'note' when the result is empty
```

`stored.title` is agent-authored and therefore attacker-influenced through a hostile saved page,
but `slugify` reduces it to `[a-z0-9-]{1,60}`. `stored.id` is minted. So no `..`, no separator,
no absolute prefix, no NUL, no unicode form reaches `resolveWrite`.

`resolveWrite` (`workspace.ts:98-123`) is independently correct anyway, and closes all three
escapes:

1. empty / NUL → `malformed` (`:101-104`);
2. absolute → refused rather than reinterpreted as relative (`:105-108`);
3. lexical containment after `resolve(root, requested)` (`:110-114`);
4. containment re-decided on the **realpath of the deepest existing ancestor**
   (`#realTarget`, `:208-225`), which is what `open()` will walk — the symlink case.

All four are asserted with escape attempts, not happy paths, in
`tests/integration/agent-workspace.test.ts:58-153`. `#realTarget` also refuses to walk above the
root while searching for an existing ancestor (`:220`).

**Verdict: no traversal.** Enforcement is at the tool boundary in the app's own code, as
`MILESTONE3.md` requires — for writes the app makes. See finding 5 for the writes it doesn't.

### Decided twice — the TOCTOU is real

`agent:accept` is `async` and the pending check is separated from the state change by three
awaits:

```
handlers.ts:751-755   getProposal → status === 'pending'?          (sync)
librarian.ts:131-135  getProposal → status === 'pending'?          (sync)
librarian.ts:142      await this.#workspace.write(...)             ← await #1
librarian.ts:200      this.#db.files.findByPath(absolutePath)      (sync)
librarian.ts:203      this.#db.documents.create({...})             (sync, UNGUARDED)
librarian.ts:209      const info = await stat(absolutePath)        ← await #2
librarian.ts:210      this.#db.files.upsertByPath({...})
librarian.ts:156      this.#db.agentRuns.accept(...)               ← the state change
```

The proposal row itself is safe: `packages/database/src/repositories/agents.ts:247` is
`UPDATE ... WHERE id = ? AND status = 'pending'`, so the second update is a no-op.

The **document** is not. Two interleaved calls both see `findByPath === null`, both call
`documents.create`, and `documents_slug_idx` is a plain index, not unique
(`packages/database/src/migrations/002_markdown.ts:47`), so the second insert succeeds.
`upsertByPath` (`packages/database/src/repositories/documents.ts:378-399`) then *repoints* the
single `document_files` row at whichever document finished second, orphaning the first.

Result of a double accept: **one file, two documents** — a phantom `source = 'librarian'`
document with a title, a slug and citation edges but no file behind it, visible in the library
list and in the graph, unopenable. Plus duplicate `librarian-note-cites` edges.

Reachable: `librarian-panel.tsx:268-275` renders Accept with no `disabled` attribute and
`decide` (`:127-143`) has no in-flight guard, so two clicks dispatch two concurrent invokes.
`ipcRenderer.invoke` is fully concurrent. Recorded as **finding 3**.

The same shape, wider, applies to `agent:run` — see finding 4.

---

## 3. The agent workspace root as a fixed `SwappableRoots` entry

`services.ts:150-157`:

```ts
const workspaceRoot = join(agentRoot, 'librarian');
const allowed = new SwappableRoots([zoteroDataDir, workspaceRoot, ...extraRoots], corpusRoot);
```

So `<agentRoot>/librarian` — *including* `.runs/`, which holds `system-prompt.md` and every
staged, un-accepted proposal — is inside the `rrfile://` allow-list.

### Is `.runs/` actually reachable to the renderer?

No, today. `rrfile://` is not a path protocol. `resolveFileRequest` (`protocol.ts:240-245`)
parses a `dfl_` file id out of the URL host and requires `db.files.getById(fileId)` to hit a
row; the allow-list is the *second* check on the path that row already contains
(`protocol.ts:249`). So reaching `.runs/` needs a `document_files` row pointing there.

Who can create one under this root?

- `LibrarianService.#registerDocument` (`librarian.ts:200-217`) — only ever for
  `notes/<slug>.md`, the accepted note.
- `MarkdownCorpusImporter` — its root is `corpusRoot`, the user-chosen notes folder. Even if
  somebody pointed the notes folder at the librarian workspace, `corpus.ts:238` skips every
  entry whose name starts with `.`, so `.runs` is never walked.
- `ExtractionPipeline` — operates on existing rows; it does not mint them from a walk.

**Verdict: correct today, wider than the requirement.** The one thing that must be servable is
`<agentRoot>/librarian/notes`, and that would be the tight root. As written, the blast radius is
"anything any future code registers a file row for, anywhere under the agent workspace,
including raw un-accepted agent output". The justification comment (`services.ts:152-154`)
explains why the workspace is *fixed* rather than swappable; it does not address why it is the
whole workspace rather than `notes/`. Recorded as **finding 8** (minor, because it is a widened
seam rather than a live hole).

Note the test that touches this asserts it with a prefix comparison
(`agent-channels.test.ts:307`: `workspaceRoot.startsWith(root)`) — the exact prefix-collision
bug `isInsideRoot` (`paths.ts:24-31`) exists to prevent. Test-only, so not a finding, but it is
the weaker check in the file that is checking the stronger one.

---

## 4. The standing invariants against milestone 3's new code

Checked, and clean:

| Invariant | Evidence |
|---|---|
| One router, zod before dispatch | `ipcMain.handle` appears once, `router.ts:163`. Every channel in `IPC_CHANNELS` carries a `request` schema; the agent ones are `ipc.ts:625-695`. `dispatch` parses before the handler (`router.ts:105-113`) and re-parses the response outside production (`:125-135`). |
| `agent:progress` topic validated on the way out | `router.ts:178-182` |
| `contextIsolation` / `nodeIntegration` / `sandbox` / `webviewTag` | `index.ts:150-153`, unchanged |
| Preload = one `invoke`, one `subscribe` | `apps/desktop/src/preload/index.ts:14-35` |
| No `any`, no `eslint-disable`, no `as unknown as` in M3 code | Repo-wide grep over `apps/*/src`, `packages/*/src`, `workers/*/src` returns exactly two hits, both milestone 2: `packages/workbench/src/workbench.ts:141` (`as unknown as EntityRef`) and `packages/note-editor/src/NoteEditorView.tsx:77` (`react-hooks/exhaustive-deps`). Nothing in `main/agents/`. |
| Renderer never imports `electron` / `better-sqlite3` / `@wr/database` / `@wr/zotero-adapter` | Grep over `apps/desktop/src/renderer` and every renderer package returns nothing. `librarian-panel.tsx` imports only `@wr/shared-ui`, `@wr/shared-types` and local `ipc.js`. |
| A11 — no retrieval in the agent path | `wiki-view.ts` imports nothing from `@wr/search`; whole text is chunk concatenation in `chunk_index` order (`:151-170`) with no limit or ranking. `CRAWL_TOOLS` (`runner.ts:36`) has no web tool; `--strict-mcp-config` with no `--mcp-config` (`runner.ts:140-141`). |
| Agent-authored note bodies cannot become HTML | No `dangerouslySetInnerHTML` or `innerHTML` anywhere in `markdown-reader`, `note-editor` or the renderer. |
| Front-matter parsing is not a YAML deserializer | Hand-rolled two-form reader, `proposals.ts:348-385`. Correct call. |
| The agent cannot choose which table a citation is looked up in | `entityTypeOf` derives the type from the id prefix, `proposals.ts:282-313`. |
| Wiki view is read-only below the tool layer | `#sealReadOnly`, `wiki-view.ts:290-298`, children first then the directory; asserted at `wiki-view.test.ts:164`. Real kernel enforcement, not a prompt. |

### The one that fails: does any agent channel return a filesystem path to the renderer?

Yes — not on a channel, on the `agent:progress` topic.

```
stream.ts:82    TARGET_KEYS = ['file_path', 'path', 'pattern', 'notebook_path', 'command']
stream.ts:84-93 toolTarget() returns that value verbatim (truncated at 200 chars)
stream.ts:168   events.push({ kind: 'tool', tool: name, target: toolTarget(input) })
services.ts:318-322  detail: `${event.tool} ${event.target}`
services.ts:733 / 283  services.publish('agent:progress', agentProgress(runId, event))
router.ts:184-186      contents.send(EVENT_CHANNEL, ...) to every webContents
librarian-panel.tsx:73-77, 208-212   setProgress(event.detail) → rendered on screen
```

Claude Code's `Read` tool takes an **absolute** `file_path`. The recorded transcript proves the
shape: `tests/fixtures/agents/librarian-stream.jsonl` line 13 carries
`{"file_path": "/tmp/wr-fix/wiki/doc_a.md"}` and line 43 carries
`{"file_path": "/private/tmp/wr-fix/run/sparse-autoencoder-feature-splitting-review.md"}`.
In production the read root is `<userData>/agent/wiki` (`services.ts:256`, `defaultAgentRoot`
`:352-357`), so the string handed to the renderer contains the user's home directory and the
Electron `userData` path.

`librarian-run.test.ts:141` even asserts the target is non-null — the leak is pinned by a test.

This contradicts, verbatim:

- `CLAUDE.md`, Security: "The renderer never receives or builds a filesystem path."
- `docs/SECURITY.md:14`: "no path, handle, or shell reaches the renderer at all"
- `docs/SECURITY.md:32`: "Renderer never receives or builds a filesystem path"
- `ipc.ts:754`, the topic's own doc: "The current step in one short line, e.g.
  `Read documents/doc_….md`" — describes a workspace-relative form that is not what is sent.

`scripts/verify_completion.py` does not check this invariant, so nothing caught it.

Impact, stated honestly: the renderer is sandboxed, has no Node API, and cannot open a path it
is given — `rrfile://` takes ids, not paths (`protocol.ts:198`). This is information disclosure
of the user's directory layout to an already-contained context, not a route to anything. But the
invariant is one of the five in `CLAUDE.md`'s never-regress list and it is now false. Recorded as
**finding 1**. The fix is a relativiser in `agentProgress` — the run's read roots are known, so
`relative(viewRoot, target)` with a fallback to the basename would keep the progress line useful
and the invariant true.

---

## 5. Stubs, and mocks standing in for feasible integration

### The wiki copy is never removed

`WikiView.remove()` (`wiki-view.ts:139-141`) has **no production caller**. Grep over the tree
finds it at `tests/integration/wiki-view.test.ts:61`,
`tests/integration/librarian-accept.test.ts:74` and
`tests/integration/agent-channels.test.ts:89` — all teardown.

Its own doc comment (`wiki-view.ts:136-138`) says:

> when agents are switched off, this is what takes the copy of the wiki back off disk.

Nothing does that. `agent:enable { enabled: false }` (`handlers.ts:704-708`) stops the timer and
cancels runs. `services.close()` (`services.ts:226-234`) stops the timer, cancels runs and closes
the database. Neither removes the view. `materialise()` clears the previous view at the *start*
of the next pass (`wiki-view.ts:74`), so between passes — and forever after the last one — the
copy sits on disk.

What that copy contains, from `materialise` (`wiki-view.ts:86-124`): every document's full
extracted text, every highlight with its comment, every research question with its next action
and discard reason, every journal entry, every note. Sealed `0444`/`0555`, at
`<userData>/agent/wiki`, readable by anything running as the user, surviving "turn the librarian
off" and surviving app uninstall.

`README.md:16` — "With agents disabled ... no copy of the wiki is made" — and the disclosure's
withhold line (`settings.ts:146`) — "Everything, while agents are off: no run is scheduled and no
wiki copy is made" — are both true in the present tense and both read, to a person deciding
whether to switch this on, as promises that turning it off undoes it. It doesn't. Recorded as
**finding 2**.

### A02's tested boundary is not the boundary the agent crosses

`workspace.ts:11-13` states:

> Every write made on the agent's behalf goes through this class. There is no other path.

The spawned `claude` writes with its own `Write` and `Edit` tools
(`CRAWL_TOOLS`, `runner.ts:36`) straight to the filesystem. It never calls `AgentWorkspace`.
What actually contains it is three things, none of them this class:

1. `cwd` = the run staging directory (`runner.ts:154`);
2. `--add-dir <wikiRoot>` on a tree that is `chmod` read-only (`wiki-view.ts:290-298`) — this one
   is real, kernel-level, and asserted (`wiki-view.test.ts:164`);
3. the `claude` CLI's own permission model under `--permission-mode acceptEdits`
   (`runner.ts:136-137`).

Item 3 is the load-bearing one for everything that is neither the run directory nor the wiki —
the user's home directory, the wiki-reader database, `~/.ssh`. There is evidence it holds: the
recorded transcript line 33 shows `Glob` on `/tmp` coming back with *"Claude requested permissions
to read from /tmp, but you haven't granted it yet"*. But that is a third-party CLI's behaviour in
one version (2.1.220, per the fixture README), it is not asserted by any test in this repo, and it
is not named in `docs/SECURITY.md`.

Every A02 test (`tests/integration/agent-workspace.test.ts`) exercises the class. None has the
child process attempt a write outside its cwd — and the harness could: `fake-claude.mjs` writes
with `writeFileSync(join(process.cwd(), basename(...)))` (`:68`), and a variant that tries
`../../notes/evil.md` or an absolute path would be a few lines. The criterion as written —
"An agent write outside its own workspace is refused and logged" — is asserted against a door the
agent does not use. Recorded as **finding 5**.

### A13's "a pass that finds nothing writes nothing" is asserted on a run that wrote something

`librarian-accept.test.ts:209-229` drives the real `librarian.pass()` against the recorded
transcript and asserts zero proposals and an empty workspace. Its comment (`:212-213`):

> The recorded transcript writes a note into the run directory but stages no proposal, which is
> exactly the shape of a pass that turned nothing up.

It is not. The recorded run **did** produce a finding — fixture line 43 is
`Write /private/tmp/wr-fix/run/sparse-autoencoder-feature-splitting-review.md`, and
`fake-claude.mjs:66-71` materialises it into the run directory root. `ProposalReader.harvest`
reads only `.runs/<id>/proposals/` (`proposals.ts:129`), so the file is invisible to it and the
pass reports nothing.

That is the shape of a **harvest miss**, not of a quiet pass. The test passes on the wrong cause.
Worse, the one recording of a real `claude` under a librarian prompt that exists in this repo put
its output where the harvester does not look, and no assertion notices. The production task
(`librarian.ts:37-45`) does ask for `./proposals/` where the recording's task did not, so this is
not proof that production would miss — but it is proof that nothing here would tell you if it did.
Recorded as **finding 6**.

### No test harvests a real agent's output

Every proposal in every test, and in the E2E, is hand-written front matter staged directly into
`.runs/<id>/proposals/`:

- `librarian-accept.test.ts:83-102`
- `agent-channels.test.ts:114-139`
- `tests/e2e/support/librarian.ts:52-107`

The comments are candid about why (`support/librarian.ts:4-7`, `agent-channels.test.ts:110-113`):
the recording predates the front matter the task now asks for and cites ids from another library.
Both are true, and both were fixable — re-recording a transcript against the current prompt and a
fixture corpus was feasible and was not done.

The consequence is that the seam between "what a `claude` under `task()` actually writes" and
"what `ProposalReader` reads" — the seam finding 6 shows is currently broken in the only recording
that exists — is not covered anywhere. A04, A06, A07, A08, A09 and A12 are all real assertions
about `ProposalReader`; none of them is an assertion about the agent. Recorded as **finding 7**.

### Not a stub

`runner.ts` is real: real `spawn`, real pipe, real line splitting, real exit codes, real argv
written to disk and asserted rather than trusted. `WikiView`, `AgentWorkspace`, `ProposalReader`,
`decidePass` and the settings/disclosure module are all real and all reasonably tested. The
schedule is a pure decision plus a thin timer, which is the right split. This section is about
three specific seams, not about the milestone being a facade.

---

## 6. Smaller things found on the way through

- **`agent:run` has a race window that spans `materialise()`.** `runner.busy`
  (`runner.ts:111-113`) reads `#active`, which is populated at `runner.ts:155` — *after*
  `view.materialise()` (`librarian.ts:94`), `runDirectory` and the prompt write. Materialise
  writes every document's full text, so on a real library the window is seconds to minutes. Two
  `agent:run` invokes inside it both pass the guard at `handlers.ts:728` (the button's `disabled`
  reads a stale `status.running`, `librarian-panel.tsx:186`), both call `materialise()` on the
  same root, and one does `rm -rf` (`wiki-view.ts:287`) while the other writes and seals. The
  surviving agent may be handed a partial wiki; two `claude` processes are spawned and billed.
  `decidePass`'s "One at a time" comment (`schedule.ts:52-54`) reads the same stale flag through
  `observe()` (`services.ts:277`). **Finding 4.**
- **`env: process.env`** (`runner.ts:154`, and `defaultSpawn` `:266-271`) hands the child the
  whole main-process environment. The disclosure says the app "never sees or stores" your
  credentials (`settings.ts:136`), which is true, but it forwards every secret in its own
  environment to a program it spawns. **Finding 10.**
- **A hung child wedges the librarian forever.** `runner.ts:175-182` sends SIGTERM on timeout but
  the promise settles only on `close` or `error` (`:201-211`). No SIGKILL escalation, no
  settle-on-timeout. A child that ignores SIGTERM leaves the entry in `#active`, so `busy` stays
  true and `decidePass` returns `already-running` (`schedule.ts:54`) for the life of the process.
  **Finding 11.**
- **`WR_AGENT_EXECUTABLE`** (`index.ts:207-209`) is a production code path: whatever binary it
  names is spawned with the full environment. Same class as `WR_DATABASE_PATH` and
  `WR_SQLITE_BINDING`, and an attacker who can set the env can already run code — but this one is
  new in M3 and is specifically "run this arbitrary program". **Finding 12.**
- **No cap on harvested output.** `proposals.ts:135` lists every `.md` in staging and `:147` reads
  each whole into memory; `#store` (`librarian.ts:176-185`) writes the body into SQLite uncapped
  while the run summary is capped at 4000 (`librarian.ts:106`). One enormous file is a
  main-process OOM. **Finding 13.**
- **`docs/SECURITY.md` was not touched for milestone 3.** No threat-model row for the librarian,
  for prompt injection from a hostile archived page, or for the child process. Line 19 —
  "nothing reaches the network except `127.0.0.1`" — is false once agents are on. Line 14 is false
  per finding 1. The invariants table gains no row for the spawn, the new allow-list root, or the
  on-disk wiki copy. **Finding 9.**
- **Dead clause.** `workspace.ts:220`: `if (!isInsideRoot(parent, root) && parent !== root)` — the
  second half is unreachable, since `isInsideRoot(root, root)` returns `true` (`paths.ts:27`).
  Harmless. **Finding 15.**

---

## Findings

| # | Sev | Finding | Evidence |
|---|---|---|---|
| 1 | critical | `agent:progress` publishes **absolute filesystem paths** to every renderer and paints them on screen, breaking `CLAUDE.md`'s "the renderer never receives or builds a filesystem path" and `docs/SECURITY.md:14,32`. The topic's own doc claims a relative form. Impact is directory-layout disclosure to a sandboxed context, not code execution — but the invariant is false and the verifier does not check it. | `stream.ts:82-93`, `services.ts:318-322`, `router.ts:184-186`, `librarian-panel.tsx:73-77,208-212`; proof of shape `tests/fixtures/agents/librarian-stream.jsonl` lines 13 and 43; pinned by `librarian-run.test.ts:141`; contract `ipc.ts:754` |
| 2 | major | The materialised wiki — full text of every document, every highlight and comment, every question, journal entry and note — is **never removed in production**. `WikiView.remove()` has no non-test caller; turning agents off does not call it. Its own comment claims it does. `README.md:16` and the disclosure read as promises this contradicts. | `wiki-view.ts:136-141` vs. `handlers.ts:704-708`, `services.ts:226-234`; callers only at `wiki-view.test.ts:61`, `librarian-accept.test.ts:74`, `agent-channels.test.ts:89`; contents `wiki-view.ts:86-124`; claims `README.md:16`, `settings.ts:146` |
| 3 | major | **TOCTOU in `agent:accept`**: a double accept mints two documents. The proposal row is protected by `WHERE status='pending'`; `documents.create` is not, and runs before it across two awaits. `documents_slug_idx` is not unique, so the duplicate lands; `upsertByPath` repoints the file row and orphans the first document. Reachable by double-clicking Accept. | `handlers.ts:750-755`, `librarian.ts:131-156,200-217`; guard `packages/database/src/repositories/agents.ts:247`; index `migrations/002_markdown.ts:47`; `documents.ts:378-399`; no UI guard `librarian-panel.tsx:127-143,268-275` |
| 4 | major | **"One pass at a time" has a race window spanning `materialise()`.** `runner.busy` goes true only after the spawn, so two `agent:run` calls both pass the guard, both rebuild the wiki view on the same root (one `rm -rf`ing while the other writes and seals), and two `claude` processes spawn. | `runner.ts:111-113,154-155`, `librarian.ts:94-98`, `handlers.ts:728`, `wiki-view.ts:74,287-298`, `schedule.ts:52-54`, `services.ts:277`, `librarian-panel.tsx:186` |
| 5 | major | **A02's enforcement point is not the one the agent crosses.** `AgentWorkspace` bounds writes the *app* makes; the spawned `claude` writes with its own tools and never calls it, despite the class header saying "there is no other path". Real containment is cwd + a `chmod`-sealed `--add-dir` + the CLI's own permission model — the last of which is untested here and unnamed in `docs/SECURITY.md`. No test has the child attempt an escape, though `fake-claude.mjs` could. | `workspace.ts:11-13` vs. `runner.ts:36,136-137,154`; real defence `wiki-view.ts:290-298` (asserted `wiki-view.test.ts:164`); CLI evidence `librarian-stream.jsonl` line 33; all A02 tests `tests/integration/agent-workspace.test.ts` |
| 6 | major | **A13's "a pass that finds nothing writes nothing" passes on the wrong cause.** The recorded run *did* write a finding; it landed in the run-directory root, and `harvest` only reads `.runs/<id>/proposals/`, so the pass reports nothing. That is a harvest miss described in the test comment as a quiet pass. | `librarian-accept.test.ts:209-229` (esp. the comment at `:212-213`); fixture line 43; `fake-claude.mjs:66-71`; `proposals.ts:129` |
| 7 | major | **No test harvests a real agent's output.** Every proposal in integration and E2E is hand-staged front matter. The seam between what a `claude` under the production `task()` writes and what `ProposalReader` reads is uncovered — the same seam finding 6 shows is broken in the only recording that exists. Re-recording against the current prompt was feasible. | `librarian-accept.test.ts:83-102`, `agent-channels.test.ts:110-139`, `tests/e2e/support/librarian.ts:4-7,52-107`; production task `librarian.ts:37-45` |
| 8 | minor | The **whole** agent workspace is in the `rrfile://` allow-list, not just `notes/`, so `.runs/` staging (raw un-accepted agent output, the system prompt) is inside the served root. Not reachable today — `rrfile://` needs a `document_files` row, and only `#registerDocument` creates one, for `notes/*.md`; the corpus importer skips dot-entries. A widened seam, not a live hole. | `services.ts:150-157`; gate `protocol.ts:240-249`; only minter `librarian.ts:200-217`; `corpus.ts:238` |
| 9 | minor | **`docs/SECURITY.md` has no milestone-3 content.** No threat-model row for the librarian, the child process, or prompt injection from a hostile saved page. Line 19 ("nothing reaches the network except `127.0.0.1`") is false with agents on; line 14 is false per finding 1; the invariants table gains no row for the spawn, the new root, or the on-disk copy. | `docs/SECURITY.md:10-19,26-38` |
| 10 | minor | The child is spawned with the **entire main-process environment**, while the disclosure implies the app is not in the credential path. | `runner.ts:154,266-271`, `settings.ts:136` |
| 11 | minor | A child that **ignores SIGTERM wedges the librarian permanently**: no SIGKILL escalation, no settle-on-timeout, so `busy` stays true and every future pass is refused as `already-running`. | `runner.ts:175-182,201-215`, `schedule.ts:54` |
| 12 | minor | **`WR_AGENT_EXECUTABLE` is a production path** — an env var that names an arbitrary binary to spawn with the full environment. A test seam shipped enabled. | `index.ts:207-209`, `services.ts:295` |
| 13 | minor | **No size or count cap on harvested proposals**: every staged `.md` is read whole into memory and the body is stored uncapped, while the run summary is capped at 4000. | `proposals.ts:135,147`, `librarian.ts:106,176-185` |
| 14 | minor | **A03's E2E observable is sound only by accident of ordering.** `<agentRoot>/wiki` catches a spawn only because `pass()` materialises before spawning; nothing enforces that, so reordering two lines leaves the assertion green while a process starts. Assert the spawn. | `tests/e2e/librarian.spec.ts:78`, `librarian.ts:94-95` |
| 15 | minor | Dead clause: `parent !== root` is unreachable because `isInsideRoot(root, root)` is `true`. | `workspace.ts:220`, `paths.ts:27` |

## Explicitly ruled out

Stated because "I traced it and it is safe" is worth as much as a finding.

- **A03, any path to spawn / `materialise` / `scheduler.start` / network with agents off.**
  Double-gated: `decidePass` returns `disabled` *and* the timer is never armed. Enabling is gated
  on the disclosure at the channel (`settings.ts:100-112`), not in a component. Only outbound
  primitive with agents off is the Zotero loopback client. Table of every caller in §1.
- **Path traversal via `agent:accept`.** The renderer supplies only a constrained id; the path is
  `notes/<[a-z0-9-]{1,60}>-<6 chars of a minted id>.md`. `resolveWrite` independently closes
  empty/NUL, absolute, lexical `..`, and symlink-through-an-existing-ancestor, each asserted with
  an escape attempt.
- **`.runs/` reachable to the renderer via `rrfile://`.** No — see §3. Recorded as a widened seam
  (finding 8), not a hole.
- **Single router, zod on every payload, `contextIsolation`/`sandbox`/`nodeIntegration`, two-function
  preload, renderer import boundary, no `any`/`eslint-disable`/`as unknown as` in M3 code.** All
  verified — see the table in §4.
- **A11, no retrieval.** No `@wr/search` import in the agent path; whole documents by chunk-index
  concatenation with no limit; no web tool; `--strict-mcp-config` with no config.
- **Agent-authored markdown becoming HTML.** No `dangerouslySetInnerHTML` or `innerHTML` in the
  reader packages or the renderer.
- **The agent choosing which table a citation resolves against.** Type comes from the id prefix.
- **The front-matter reader as a deserialization surface.** Two hand-parsed forms, no YAML engine.
- **`agent:accept`/`reject`/`listProposals` being unguarded by `enabled`.** By design — triaging
  proposals that already exist while the switch is off writes only into the workspace.
