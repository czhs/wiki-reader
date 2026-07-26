#!/usr/bin/env python3
"""Render Claude Code stream-json as live human-readable output.

Each of the model's turns is announced with a wall-clock time, its number, and how long the
previous one took, so a run that is grinding is visible as it happens rather than after it.

Counting turns needs three facts about the stream, all established by reading a real log
(`logs/ralph/iter_1_20260725_155832.log`) rather than assumed:

  - One assistant *message* arrives as several `assistant` events, all sharing `message.id`.
    Counting events gives 545 where there were 264; the ids are what to count.
  - Sub-agent messages are interleaved with the main loop's and carry `parent_tool_use_id`
    (plus `subagent_type`). They are somebody else's turns and must not advance the counter.
  - Every `assistant` event carries an ISO-8601 `timestamp`. `stream_event` does not, so the
    time shown is the model's, not this script's reading of the clock.

The harness's own `num_turns` — the one `--max-turns` enforces — counts differently again
(184 where distinct main-loop assistant ids were 145), so the closing line prints it verbatim
beside ours instead of quietly showing one of them.
"""
import json
import os
import sys
from datetime import datetime, timezone

ITER = os.environ.get("RALPH_ITER", "")
MAX_TURNS = os.environ.get("RALPH_MAX_TURNS", "")
TURN_LOG = os.environ.get("RALPH_TURN_LOG", "")

turn = 0
seen = set()
prev_at = None
started_at = None
last_at = None


def parse_ts(raw):
    """Event timestamps are ISO-8601 UTC ('...Z'), which fromisoformat rejects before 3.11."""
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def note(text):
    """Append to the per-iteration turn log, if the loop asked for one. Never ANSI."""
    if not TURN_LOG:
        return
    try:
        with open(TURN_LOG, "a") as fh:
            fh.write(text + "\n")
    except OSError:
        pass  # a missing turn log must never take the run down


def mmss(seconds):
    return f"{int(seconds) // 60:d}m{int(seconds) % 60:02d}s"


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        ev = json.loads(line)
    except json.JSONDecodeError:
        print(line, flush=True)
        continue
    t = ev.get("type")

    if t == "assistant" and not ev.get("parent_tool_use_id"):
        mid = ev.get("message", {}).get("id")
        if mid and mid not in seen:
            seen.add(mid)
            turn += 1
            at = parse_ts(ev.get("timestamp")) or datetime.now(timezone.utc)
            if started_at is None:
                started_at = at
            local = at.astimezone()
            since = f" +{mmss((at - prev_at).total_seconds())}" if prev_at else ""
            elapsed = mmss((at - started_at).total_seconds())
            prev_at = at
            last_at = at

            label = f"turn {turn}" + (f"/{MAX_TURNS}" if MAX_TURNS else "")
            where = f"iter {ITER} · " if ITER else ""
            stamp = local.strftime("%H:%M:%S")
            print(
                f"\n\033[1;34m── {where}{label} · {stamp}{since} · {elapsed} in ──\033[0m",
                flush=True,
            )
            note(f"{local.isoformat(timespec='seconds')}  iter={ITER or '-'} turn={turn} elapsed={elapsed}")

    elif t == "stream_event":
        e = ev.get("event", {})
        et = e.get("type")
        if et == "content_block_delta":
            d = e.get("delta", {})
            if d.get("type") == "text_delta":
                sys.stdout.write(d.get("text", ""))
                sys.stdout.flush()
        elif et == "content_block_start":
            cb = e.get("content_block", {})
            if cb.get("type") == "tool_use":
                print(f"\n\033[36m[tool] {cb.get('name', '?')}\033[0m", flush=True)

    elif t == "user":
        content = ev.get("message", {}).get("content", [])
        if isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get("type") == "tool_result":
                    txt = c.get("content")
                    if isinstance(txt, list):
                        txt = " ".join(
                            b.get("text", "") for b in txt if isinstance(b, dict)
                        )
                    txt = (txt or "").strip().replace("\n", " ")
                    if len(txt) > 200:
                        txt = txt[:200] + "..."
                    print(f"\033[90m  -> {txt}\033[0m", flush=True)

    elif t == "result":
        cost = ev.get("total_cost_usd")
        reported = ev.get("num_turns")
        # First turn to last, not `now()` — that keeps the figure consistent with the
        # per-turn elapsed times already on screen, and correct when replaying an old log.
        wall = ""
        if started_at is not None and last_at is not None:
            wall = f" span={mmss((last_at - started_at).total_seconds())}"
        print(
            f"\n\033[33m[done] turns={turn} (harness num_turns={reported}) "
            f"cost={cost}{wall}\033[0m",
            flush=True,
        )
        note(f"[done] turns={turn} harness_num_turns={reported} cost={cost}")
