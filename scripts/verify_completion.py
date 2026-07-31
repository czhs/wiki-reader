#!/usr/bin/env python3
"""Deterministic milestone-1 completion verifier for wiki-reader.

Exits 0 only when every mandatory criterion in docs/MILESTONE.md is satisfied by
evidence gathered here. Claims recorded in state files are ignored: tests are
re-run and re-parsed on every invocation.

Writes reports/completion_verification.json and a human-readable summary.

Usage:
    python3 scripts/verify_completion.py            # full run
    python3 scripts/verify_completion.py --fast     # skip e2e (never satisfies completion)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "reports"
LOGS = ROOT / "logs" / "verify"

# --------------------------------------------------------------------------------------
# Criterion tags. Keep in sync with docs/MILESTONE{,2,3,4}.md.
# --------------------------------------------------------------------------------------

UNIT_TAGS = {
    "M03": "SQLite database and migrations initialize",
    "M04": "Zotero items can be imported through the local API",
    "M08": "Reading position is persisted",
    "M09": "PDF text is extracted and added to FTS5",
    "M10": "Search results can open the correct PDF page",
    "M12": "The highlight survives application restart",
    "M13": "A note can be attached to the highlight",
    "M14": "The workspace layout survives restart",
    "L01": "Internal links between notes, annotations, and documents",
    "L03": "Shift+F12 lists all references to the current entity",
    "L04": "A command lists all links of the selected link's type",
    "L05": "A command goes from an annotation to its parent document",
    "L06": "Back and forward navigation history",
    "L07": "Open-current and open-to-side actions",
    "L09": "Centralized command and keybinding registry",
    "L10": "Persistence tests for links and navigation targets",
    "T01": "Database migrations",
    "T02": "Zotero item mapping",
    "T03": "Duplicate-import prevention",
    "T04": "PDF anchor serialization",
    "T05": "HTML text normalization",
    "T06": "Text quote anchor resolution",
    "T07": "Search indexing",
    "T08": "Search result location mapping",
    "T09": "Internal link parsing",
    "T10": "Workspace layout serialization",
    # --- milestone 2 (docs/MILESTONE2.md) ---
    "W02": "A markdown selection becomes a highlight that survives restart",
    "W04": "rrfile:// serves a snapshot's resources and refuses everything outside it",
    "W05": "A web-snapshot highlight survives restart",
    "W06": "[[slug]] parses from the AST and resolves; code fences are ignored",
    "W07": "Re-indexing replaces derived links and preserves manual ones",
    "W08": "An unresolved [[slug]] is a wanted page, not an error",
    "W10": "Graph queries run in main; the renderer never receives the full graph",
    "W11": "A highlight's colour is one of six presets and survives restart",
    "W12": "Zotero import is scoped to a collection and is additive",
    # --- milestone 3 (docs/MILESTONE3.md) ---
    "C02": "The notes folder is chosen in-app; documents outside it are purged",
    "Q01": "A question's status survives restart",
    "Q03": "A discarded question keeps its reason and leaves the active list",
    "Q04": "A question links to documents and annotations as typed edges",
    "J01": "A dated journal entry survives restart",
    "J02": "The calendar marks logged days and collapses long unlogged runs",
    "J03": "A journal entry links to the question it advances",
    "A01": "A headless claude runs under an overriding system prompt and streams",
    "A02": "An agent write outside its own workspace is refused and logged",
    "A04": "Every citation in a proposal resolves to a document in the wiki",
    "A06": "A connection names both threads it joins and why",
    "A07": "A logged contradiction cites both sides",
    "A08": "Evidence for a question is surfaced both supporting and opposing",
    "A09": "Suggesting research directions can be switched off",
    "A11": "The librarian reads whole documents; no retrieval in its path",
    "A12": "A workspace note records the documents it covers",
    "A13": "The librarian runs on a schedule; a pass finding nothing writes nothing",
    "U08": "Deleting a highlight or comment removes its node from the graph",
    # --- milestone 4 (docs/MILESTONE4.md) ---
    "N01": "A question has a markdown body that survives restart",
    "N02": "The body keeps its sections — question, background, hypotheses, log",
    "N03": "A notebook page carries description, importance, started, next action, tags, cover",
    "N04": "A hypothesis is an entity on a question, with its own id and status",
    "N05": "Evidence links to a hypothesis, supporting or opposing, and is cited",
    "B01": "A removed document comes back when its collection is imported again",
    "B03": "Removing a document leaves its annotations and links recoverable",
    "B04": "~/Zotero/zotero.sqlite is untouched by every library edit",
    "G03": "A node's display name does not rewrite the document's title",
    "G05": "Card art is off by default; a fetched icon is cached",
    # --- milestone 5 (docs/MILESTONE5.md) ---
    "P02": "A day's journal entry belongs to the notebook it was written under",
    "H02": "A highlight links to a whole file, or to a highlight in another file",
}

E2E_TAGS = {
    "M01": "Electron application launches correctly",
    "M02": "Dockview workspace renders",
    "M05": "Imported items appear in the library sidebar",
    "M06": "A Zotero PDF attachment can be opened in a tab",
    "M07": "Two PDFs can be opened side by side",
    "M11": "A PDF text selection can be highlighted",
    "L02": "F12 opens the target under the cursor",
    "L08": "References panel remains open while navigating results",
    # --- milestone 2 (docs/MILESTONE2.md) ---
    "W01": "A markdown document opens in a tab and renders",
    "W03": "A saved web page renders as the original, with its images and CSS",
    "W09": "The graph renders nodes and edges; clicking a node opens that document",
    # --- milestone 3 (docs/MILESTONE3.md) ---
    "C01": "Zotero import is scoped by picking collections, and the picks stick",
    "C03": "Every activity-bar control has a visible label",
    "Q02": "The queue is hand-ordered and the order survives restart",
    "A03": "Agents are off until enabled; enabling discloses what would be sent",
    "A05": "Accepting a proposal writes it; rejecting writes nothing",
    "A10": "A citation navigates to its source location",
    # --- usability, found by using the app at 117/117 (docs/MILESTONE3.md) ---
    "U01": "Cmd/Ctrl+W closes the focused tab, not the window",
    "U02": "A split group can be closed, including its last tab",
    "U03": "A tab's close control stays hit-able however long the title",
    "U04": "Opening a sidebar replaces the open one; the reader keeps its width",
    "U05": "The graph opens with nothing selected, or says what it needs",
    "U06": "A highlight's comment is written and read back from the reader",
    "U07": "A control disabled by a precondition says which one",
    # --- milestone 4 (docs/MILESTONE4.md) ---
    "N06": "A question's desk board holds hand-placed cards, and they survive restart",
    "N07": "A dropped file becomes a card without leaving the researcher's disk",
    "N08": "A question's notebook is reached from the queue, and names its question",
    "N09": "The journal opens as a page in the workspace, not a sidebar",
    "N10": "The journal shows every day since the project began, and a day opens to its entry",
    "N11": "A day's entry is a block notebook, the page's main surface",
    "B02": "A file on disk is added to the library without going through Zotero",
    "B05": "A Zotero collection is imported from the library in one action",
    "G01": "The graph pans and zooms, and the view survives reopening the panel",
    "G02": "Graph settings — spacing, labels, depth — are changed and persist",
    "G04": "A node takes an icon from a local image, served over rrfile://",
    "G06": "A document's highlights are drawn grouped with it; edges cross groups",
    "K01": "Two documents are linked from the reader, with a typed relationship",
    "K02": "A note is created from the reader, linked to what it was made from",
    "K03": "Every action with a keybinding is discoverable without knowing the key",
    # --- milestone 5 (docs/MILESTONE5.md) ---
    "P01": "A directory page lists every notebook, and opening one lands on its page",
    "P03": "A journal's start date is the researcher's to set; the calendar begins there",
    "P04": "An image is inserted into a notebook block, and the bytes stay local",
    "P05": "Clicking into a block puts the caret at the click, not the start of the box",
    "F01": "The wiki is its own page: the whole graph, and clicking a node opens it",
    "F02": "A file opens a focused view — annotations center-stage, connected files at the edge",
    "F03": "The focused view crawls: choosing a connected file refocuses in the same view",
    "H01": "A highlight is made on a saved web page, and it survives restart",
    "H03": "A file's ledger gathers links on the file and its highlights, and links the file",
    "H04": "A link's target is picked from the graph — a file node or one of its annotations",
}

TAG_RE = re.compile(r"\[([A-Z]\d{2})\]")

# Renderer-side source must never import main-process-only code. These are source *roots*,
# not packages: apps/desktop/src/renderer is the largest renderer surface in the tree and is
# not a package, so a package-shaped list silently excluded it.
RENDERER_SOURCE_ROOTS = [
    "packages/workbench/src",
    "packages/pdf-reader/src",
    "packages/html-reader/src",
    "packages/markdown-reader/src",
    "packages/annotations/src",
    "packages/note-editor/src",
    "packages/shared-ui/src",
    # Shared between main (which bounds the query with it) and the renderer (which lays the
    # answer out with it), so it is renderer-side source too and the rule has to reach it.
    "packages/graph/src",
    "apps/desktop/src/renderer",
]
FORBIDDEN_RENDERER_IMPORTS = [
    "electron",
    "better-sqlite3",
    "@wr/database",
    "@wr/zotero-adapter",
    # Main-only per CLAUDE.md's layout table, and each pulls in better-sqlite3 or pdfjs
    # through its own dependencies.
    "@wr/search",
    "@wr/text-extraction-worker",
    "@wr/indexing-worker",
    "node:fs",
    "node:child_process",
    "node:path",
    # The bare specifiers resolve to the same builtins; only the node:-prefixed forms were
    # ever checked.
    "fs",
    "child_process",
    "path",
]

REQUIRED_DOCS = [
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "CLAUDE.md",
    "docs/SPEC.md",
    "docs/MILESTONE.md",
    "docs/MILESTONE2.md",
    "docs/MILESTONE3.md",
    "docs/MILESTONE4.md",
    "docs/MILESTONE5.md",
    "docs/AGENTS.md",
    "docs/LOOP.md",
    "docs/ARCHITECTURE.md",
    "docs/SECURITY.md",
    "docs/IPC.md",
    "docs/DATABASE.md",
    "docs/ZOTERO.md",
    "docs/HANDOFF.md",
    "reports/AUDIT.md",
]

README_REQUIRED_SECTIONS = [
    "setup",
    "development",
    "build",
    "test",
    "architecture",
    "security",
    "migration",
    "zotero",
    "unsupported",
]


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""
    data: dict = field(default_factory=dict)


CHECKS: list[Check] = []


def record(name: str, ok: bool, detail: str = "", **data) -> bool:
    CHECKS.append(Check(name=name, ok=ok, detail=detail, data=data))
    mark = "PASS" if ok else "FAIL"
    color = "\033[32m" if ok else "\033[31m"
    print(f"{color}[{mark}]\033[0m {name}" + (f" — {detail}" if detail else ""), flush=True)
    return ok


def run(
    cmd: list[str],
    timeout: int = 1800,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
) -> tuple[int, str, str]:
    try:
        p = subprocess.run(
            cmd,
            cwd=str(cwd or ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "CI": "1", "FORCE_COLOR": "0", **(env or {})},
        )
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"
    except FileNotFoundError as exc:
        return 127, "", str(exc)


def write_log(name: str, content: str) -> Path:
    LOGS.mkdir(parents=True, exist_ok=True)
    path = LOGS / f"{name}.log"
    path.write_text(content, encoding="utf-8")
    return path


# --------------------------------------------------------------------------------------
# Test-result parsing
# --------------------------------------------------------------------------------------


def parse_vitest(payload: dict) -> dict[str, str]:
    """Map full test title -> status ('passed' | 'failed' | 'skipped')."""
    out: dict[str, str] = {}
    for suite in payload.get("testResults", []) or []:
        for a in suite.get("assertionResults", []) or []:
            title = a.get("fullName") or a.get("title") or ""
            status = a.get("status", "unknown")
            prev = out.get(title)
            # A title failing anywhere counts as failing.
            if prev == "failed":
                continue
            out[title] = status
    return out


def parse_playwright(payload: dict) -> dict[str, str]:
    out: dict[str, str] = {}

    def walk(suite: dict, prefix: str = "") -> None:
        title = suite.get("title", "")
        path = f"{prefix} {title}".strip()
        for spec in suite.get("specs", []) or []:
            spec_title = f"{path} {spec.get('title', '')}".strip()
            statuses = []
            for t in spec.get("tests", []) or []:
                for r in t.get("results", []) or []:
                    statuses.append(r.get("status", "unknown"))
            if not statuses:
                out[spec_title] = "unknown"
            elif "passed" in statuses and "failed" not in statuses:
                out[spec_title] = "passed"
            elif "failed" in statuses:
                out[spec_title] = "failed"
            else:
                out[spec_title] = statuses[0]
        for child in suite.get("suites", []) or []:
            walk(child, path)

    for suite in payload.get("suites", []) or []:
        walk(suite)
    return out


def tag_index(titles: dict[str, str]) -> dict[str, dict[str, list[str]]]:
    """tag -> {'passed': [...], 'failed': [...], 'other': [...]}"""
    idx: dict[str, dict[str, list[str]]] = {}
    for title, status in titles.items():
        for tag in TAG_RE.findall(title):
            bucket = idx.setdefault(tag, {"passed": [], "failed": [], "other": []})
            key = status if status in ("passed", "failed") else "other"
            bucket[key].append(title)
    return idx


def check_tags(idx: dict[str, dict[str, list[str]]], tags: dict[str, str], label: str) -> bool:
    all_ok = True
    for tag, desc in sorted(tags.items()):
        bucket = idx.get(tag)
        if not bucket:
            all_ok &= record(f"{label} {tag}", False, f"no test tagged [{tag}] — {desc}")
            continue
        if bucket["failed"]:
            all_ok &= record(
                f"{label} {tag}", False,
                f"{len(bucket['failed'])} failing tagged test(s)",
                failing=bucket["failed"][:5],
            )
            continue
        if not bucket["passed"]:
            all_ok &= record(
                f"{label} {tag}", False,
                f"tagged test(s) exist but none passed (skipped/todo?)",
                other=bucket["other"][:5],
            )
            continue
        all_ok &= record(
            f"{label} {tag}", True,
            f"{len(bucket['passed'])} passing", tests=bucket["passed"][:5],
        )
    return all_ok


# --------------------------------------------------------------------------------------
# Individual checks
# --------------------------------------------------------------------------------------


def check_toolchain() -> bool:
    ok = True
    if shutil.which("pnpm") is None:
        ok &= record("toolchain: pnpm present", False, "pnpm not on PATH")
    else:
        ok &= record("toolchain: pnpm present", True)
    if not (ROOT / "node_modules").is_dir():
        ok &= record("toolchain: dependencies installed", False, "node_modules missing — run pnpm install")
    else:
        ok &= record("toolchain: dependencies installed", True)
    return ok


def check_typecheck() -> bool:
    code, out, err = run(["pnpm", "typecheck"])
    log = write_log("typecheck", out + err)
    errors = len(re.findall(r"error TS\d+", out + err))
    return record(
        "pnpm typecheck exits 0 with no errors",
        code == 0 and errors == 0,
        f"exit={code} ts_errors={errors} log={log.relative_to(ROOT)}",
    )


def check_lint() -> bool:
    code, out, err = run(["pnpm", "lint"])
    log = write_log("lint", out + err)
    return record(
        "pnpm lint exits 0 with no warnings",
        code == 0,
        f"exit={code} log={log.relative_to(ROOT)}",
    )


def check_no_any() -> bool:
    """Reject explicit `any` type annotations in first-party source."""
    pattern = re.compile(r"(?<![\w$])any(?![\w$])")
    offenders: list[str] = []
    disables: list[str] = []
    roots = [ROOT / "packages", ROOT / "apps", ROOT / "workers"]
    for base in roots:
        if not base.is_dir():
            continue
        for path in base.rglob("*.ts*"):
            parts = set(path.parts)
            if "node_modules" in parts or "dist" in parts or "out" in parts:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for lineno, line in enumerate(text.splitlines(), 1):
                stripped = line.strip()
                if "eslint-disable" in stripped:
                    disables.append(f"{path.relative_to(ROOT)}:{lineno}")
                if stripped.startswith("//") or stripped.startswith("*"):
                    continue
                # Only flag `any` used as a type position, not the word in prose/identifiers.
                if re.search(r"[:<|&(,\[]\s*any\b", line) or re.search(r"\bas\s+any\b", line):
                    if pattern.search(line):
                        offenders.append(f"{path.relative_to(ROOT)}:{lineno}: {stripped[:100]}")
    ok = not offenders
    return record(
        "no explicit `any` in first-party source",
        ok,
        f"{len(offenders)} occurrence(s), {len(disables)} eslint-disable line(s)",
        offenders=offenders[:20],
        eslint_disables=disables[:20],
    )


def check_renderer_boundary() -> bool:
    offenders: list[str] = []
    for source_root in RENDERER_SOURCE_ROOTS:
        base = ROOT / source_root
        if not base.is_dir():
            continue
        for path in base.rglob("*.ts*"):
            if "node_modules" in path.parts:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for lineno, line in enumerate(text.splitlines(), 1):
                m = re.search(r"""(?:from|import\()\s*['"]([^'"]+)['"]""", line)
                if not m:
                    continue
                mod = m.group(1)
                for forbidden in FORBIDDEN_RENDERER_IMPORTS:
                    if mod == forbidden or mod.startswith(forbidden + "/"):
                        offenders.append(f"{path.relative_to(ROOT)}:{lineno} imports {mod}")
    return record(
        "renderer sources do not import main-process code",
        not offenders,
        f"{len(offenders)} violation(s)",
        offenders=offenders[:20],
    )


def check_security_flags() -> bool:
    main_src = ROOT / "apps" / "desktop" / "src" / "main"
    if not main_src.is_dir():
        return record("security: main process source present", False, "apps/desktop/src/main missing")
    blob = "\n".join(
        p.read_text(encoding="utf-8", errors="ignore")
        for p in main_src.rglob("*.ts")
        if "node_modules" not in p.parts
    )
    ok = True
    required = {
        "contextIsolation: true": r"contextIsolation\s*:\s*true",
        "nodeIntegration: false": r"nodeIntegration\s*:\s*false",
        "sandbox: true": r"sandbox\s*:\s*true",
    }
    for label, pat in required.items():
        ok &= record(f"security: {label}", bool(re.search(pat, blob)))

    # The three checks above search a concatenation of the main-process sources, so they only
    # prove the secure value appears *somewhere*. On their own they would still pass if a
    # second window were constructed with the flags inverted. Forbidding the insecure literals
    # outright is what makes them binding on every construction site.
    forbidden = {
        "webSecurity: false": r"webSecurity\s*:\s*false",
        "contextIsolation: false": r"contextIsolation\s*:\s*false",
        "nodeIntegration: true": r"nodeIntegration\s*:\s*true",
        "sandbox: false": r"sandbox\s*:\s*false",
        "allowRunningInsecureContent": r"allowRunningInsecureContent\s*:\s*true",
        "nodeIntegrationInSubFrames": r"nodeIntegrationInSubFrames\s*:\s*true",
        "enableRemoteModule": r"enableRemoteModule\s*:\s*true",
    }
    all_src = "\n".join(
        p.read_text(encoding="utf-8", errors="ignore")
        for base in (ROOT / "apps", ROOT / "packages")
        if base.is_dir()
        for p in base.rglob("*.ts*")
        if "node_modules" not in p.parts and "dist" not in p.parts
    )
    for label, pat in forbidden.items():
        ok &= record(f"security: no {label}", not re.search(pat, all_src))
    return ok


def check_ipc_validation() -> bool:
    """Every IPC handler must route through the validating router."""
    main_src = ROOT / "apps" / "desktop" / "src" / "main"
    if not main_src.is_dir():
        return record("ipc: validating router present", False, "main source missing")
    raw_handlers: list[str] = []
    for p in main_src.rglob("*.ts"):
        if "node_modules" in p.parts:
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        for lineno, line in enumerate(text.splitlines(), 1):
            if re.search(r"ipcMain\.(handle|on)\b", line) and "router" not in p.name:
                raw_handlers.append(f"{p.relative_to(ROOT)}:{lineno}")
    return record(
        "ipc: no ipcMain handlers outside the validating router",
        not raw_handlers,
        f"{len(raw_handlers)} raw handler(s)",
        offenders=raw_handlers[:20],
    )


def check_docs() -> bool:
    ok = True
    for rel in REQUIRED_DOCS:
        path = ROOT / rel
        present = path.is_file() and path.stat().st_size > 200
        ok &= record(f"docs: {rel}", present, "" if present else "missing or too short")
    readme = ROOT / "README.md"
    if readme.is_file():
        text = readme.read_text(encoding="utf-8", errors="ignore").lower()
        missing = [s for s in README_REQUIRED_SECTIONS if s not in text]
        ok &= record(
            "docs: README covers required sections", not missing,
            f"missing: {', '.join(missing)}" if missing else "",
        )
    return ok


def check_audit() -> bool:
    """The audit gate requires positive evidence that an audit ran.

    The previous implementation only searched for markers of *failure*, so an empty file — or
    the "Status: not yet performed" placeholder this repository actually shipped for 25
    iterations — satisfied it trivially. The audit is the one check meant to catch tests that
    assert nothing, criteria satisfied by mocks, and stubs presented as working, so a gate it
    can pass without running is worse than no gate.

    An audit now has to name the commit it examined, and that commit has to be real and
    reachable. That makes a stale audit visible instead of eternally valid.

    Reachability alone was not enough. Once milestone 4 was armed, the milestone-3 audit still
    satisfied this gate — it names a commit that is still an ancestor of HEAD, and always will
    be. So an audit must also name the *milestone* it examined, and that has to be the milestone
    being gated. Requiring instead that the audited commit be the newest one would be wrong in
    the other direction: closing an audit's findings necessarily commits after the audit ran.
    """
    ok = True
    path = ROOT / "reports" / "AUDIT.md"
    if not path.is_file():
        return record("audit: reports/AUDIT.md present", False, "missing")

    raw = path.read_text(encoding="utf-8", errors="ignore")
    text = raw.lower()

    placeholder = re.search(r"not\s+(yet\s+)?performed|placeholder|^\s*todo\b", text, re.M)
    ok &= record(
        "audit: AUDIT.md is not a placeholder",
        not placeholder,
        f"placeholder marker {placeholder.group(0)!r}" if placeholder else "",
    )

    # An audit must state which commit it examined, and that commit must exist in history.
    m = re.search(r"audited-commit:\s*([0-9a-f]{7,40})", text)
    if m is None:
        ok &= record(
            "audit: names the commit it audited",
            False,
            "no 'Audited-commit: <sha>' line",
        )
    else:
        sha = m.group(1)
        code, _, _ = run(["git", "merge-base", "--is-ancestor", sha, "HEAD"], timeout=30)
        ok &= record(
            "audit: audited commit is reachable from HEAD",
            code == 0,
            f"{sha} is not an ancestor of HEAD" if code != 0 else f"commit={sha}",
        )

    # The milestone under construction is the highest-numbered criteria doc in the tree, so
    # this needs no second place to keep the number in sync.
    gated = max(
        (int(p.stem.removeprefix("MILESTONE") or "1") for p in (ROOT / "docs").glob("MILESTONE*.md")),
        default=1,
    )
    claimed = re.search(r"audited-milestone:\s*(\d+)", text)
    ok &= record(
        f"audit: audited milestone {gated}",
        claimed is not None and int(claimed.group(1)) == gated,
        (
            "no 'Audited-milestone: <n>' line"
            if claimed is None
            else f"audit is of milestone {claimed.group(1)}, gate is milestone {gated}"
        ),
    )

    # The auditor's brief is to falsify; a report with no findings section did not look.
    ok &= record(
        "audit: reports its findings",
        bool(re.search(r"^#+\s*findings\b", text, re.M)),
        "no '## Findings' section",
    )

    unresolved = re.search(r"unresolved\s*(critical|major)", text) or re.search(
        r"status:\s*(fail|blocked)", text
    )
    ok &= record(
        "audit: no unresolved critical or major findings",
        not unresolved,
        "AUDIT.md reports unresolved findings" if unresolved else "",
    )
    return ok


def check_state() -> bool:
    ok = True
    for rel in ["state/experiment_state.json", "state/MILESTONE_STATUS.json"]:
        path = ROOT / rel
        if not path.is_file():
            ok &= record(f"state: {rel} present", False, "missing")
            continue
        try:
            json.loads(path.read_text(encoding="utf-8"))
            ok &= record(f"state: {rel} parses", True)
        except json.JSONDecodeError as exc:
            ok &= record(f"state: {rel} parses", False, str(exc))
    st = ROOT / "state" / "experiment_state.json"
    if st.is_file():
        try:
            phase = json.loads(st.read_text(encoding="utf-8")).get("phase")
            ok &= record(
                "state: phase is milestone-1-complete",
                phase == "milestone-1-complete",
                f"phase={phase!r}",
            )
        except json.JSONDecodeError:
            ok &= record("state: phase is milestone-1-complete", False, "unparseable")
    return ok


def check_git() -> bool:
    ok = True
    code, out, _ = run(["git", "status", "--porcelain"], timeout=60)
    dirty = [l for l in out.splitlines() if l.strip()]
    ok &= record("git: working tree clean", code == 0 and not dirty,
                 f"{len(dirty)} dirty path(s)", dirty=dirty[:20])

    code, branch, _ = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], timeout=60)
    branch = branch.strip()
    ok &= record("git: on branch main", branch == "main", f"branch={branch!r}")

    code, remote, _ = run(["git", "remote", "get-url", "origin"], timeout=60)
    remote = remote.strip()
    expected = "czhs/wiki-reader"
    ok &= record("git: origin is czhs/wiki-reader", expected in remote, f"origin={remote!r}")

    code, head, _ = run(["git", "rev-parse", "HEAD"], timeout=60)
    head = head.strip()
    code2, ls, _ = run(["git", "ls-remote", "origin", "refs/heads/main"], timeout=180)
    remote_head = ls.split()[0] if ls.split() else ""
    ok &= record(
        "git: HEAD is present on origin/main",
        bool(head) and head == remote_head,
        f"local={head[:8]} remote={remote_head[:8]}",
    )
    return ok


def check_no_user_data_committed() -> bool:
    code, out, _ = run(["git", "ls-files"], timeout=120)
    bad: list[str] = []
    for rel in out.splitlines():
        low = rel.lower()
        if low.endswith((".sqlite", ".db")) or "/zotero/storage/" in low:
            bad.append(rel)
        path = ROOT / rel
        if path.is_file() and path.stat().st_size > 10 * 1024 * 1024:
            bad.append(f"{rel} (>10MB)")
    return record("git: no databases or oversized binaries tracked", not bad,
                  f"{len(bad)} offender(s)", offenders=bad[:20])


# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fast", action="store_true",
                    help="skip e2e; can never satisfy completion")
    args = ap.parse_args()

    started = time.time()
    print("=== wiki-reader milestone-1 completion verifier ===\n", flush=True)

    ok = True
    ok &= check_toolchain()

    # --- unit + integration tests -----------------------------------------------------
    unit_json = LOGS / "vitest.json"
    LOGS.mkdir(parents=True, exist_ok=True)
    code, out, err = run(
        ["pnpm", "exec", "vitest", "run", "--reporter=json",
         f"--outputFile={unit_json}"],
        timeout=2400,
    )
    write_log("vitest", out + err)
    unit_titles: dict[str, str] = {}
    if unit_json.is_file():
        try:
            unit_titles = parse_vitest(json.loads(unit_json.read_text(encoding="utf-8")))
        except json.JSONDecodeError as exc:
            record("tests: vitest JSON parses", False, str(exc))
            ok = False
    if not unit_titles:
        ok &= record("tests: vitest produced results", False,
                     f"exit={code}; no parseable assertions")
    else:
        failed = [t for t, s in unit_titles.items() if s == "failed"]
        ok &= record("tests: vitest suite green", code == 0 and not failed,
                     f"{len(unit_titles)} tests, {len(failed)} failed",
                     failing=failed[:10])

    ok &= check_tags(tag_index(unit_titles), UNIT_TAGS, "criterion")

    # --- e2e --------------------------------------------------------------------------
    if args.fast:
        record("tests: e2e executed", False, "--fast supplied; e2e skipped")
        ok = False
    else:
        e2e_json = LOGS / "playwright.json"
        # A stale report must never satisfy this gate: remove it before the run, so a crashed
        # or unparseable run fails rather than inheriting the last green one.
        LOGS.mkdir(parents=True, exist_ok=True)
        e2e_json.unlink(missing_ok=True)
        # No literal "--" separator: pnpm forwards it verbatim, and Playwright's parser treats
        # it as end-of-options, silently demoting "--reporter=json" to a positional file
        # filter. The reporter then never overrode the config and this gate could not pass.
        # PLAYWRIGHT_JSON_OUTPUT_NAME puts the report in a file, so pnpm's build chatter on
        # stdout cannot corrupt it.
        code, out, err = run(
            ["pnpm", "test:e2e", "--reporter=json"],
            timeout=2400,
            env={"PLAYWRIGHT_JSON_OUTPUT_NAME": str(e2e_json)},
        )
        write_log("playwright", out + err)
        e2e_titles: dict[str, str] = {}
        payload = None
        if e2e_json.is_file():
            try:
                payload = json.loads(e2e_json.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                payload = None
        if payload is None:
            # Playwright's json reporter may write to stdout.
            brace = out.find("{")
            if brace >= 0:
                try:
                    payload = json.loads(out[brace:])
                except json.JSONDecodeError:
                    payload = None
        if payload is not None:
            e2e_titles = parse_playwright(payload)
        if not e2e_titles:
            ok &= record("tests: e2e produced results", False,
                         f"exit={code}; no parseable specs")
        else:
            failed = [t for t, s in e2e_titles.items() if s == "failed"]
            ok &= record("tests: e2e suite green", code == 0 and not failed,
                         f"{len(e2e_titles)} specs, {len(failed)} failed",
                         failing=failed[:10])
        ok &= check_tags(tag_index(e2e_titles), E2E_TAGS, "criterion")

    # --- static gates -----------------------------------------------------------------
    ok &= check_typecheck()
    ok &= check_lint()
    ok &= check_no_any()
    ok &= check_renderer_boundary()
    ok &= check_security_flags()
    ok &= check_ipc_validation()
    ok &= check_docs()
    ok &= check_audit()
    ok &= check_state()
    ok &= check_no_user_data_committed()
    ok &= check_git()

    # --- report -----------------------------------------------------------------------
    REPORTS.mkdir(parents=True, exist_ok=True)
    failures = [c.name for c in CHECKS if not c.ok]
    report = {
        "schema_version": 1,
        "verified_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "duration_seconds": round(time.time() - started, 1),
        "complete": bool(ok),
        "checks_total": len(CHECKS),
        "checks_failed": len(failures),
        "failed_checks": failures,
        "checks": [asdict(c) for c in CHECKS],
    }
    (REPORTS / "completion_verification.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )

    print()
    print(f"checks: {len(CHECKS) - len(failures)}/{len(CHECKS)} passed "
          f"in {report['duration_seconds']}s")
    if failures:
        print("\nfailed checks:")
        for name in failures:
            print(f"  - {name}")
        print("\nMILESTONE INCOMPLETE")
        return 1
    print("\nMILESTONE COMPLETE — all mandatory criteria verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
