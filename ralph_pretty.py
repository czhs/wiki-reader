#!/usr/bin/env python3
"""Render Claude Code stream-json as live human-readable output."""
import json
import sys

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
    if t == "stream_event":
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
        turns = ev.get("num_turns")
        print(f"\n\033[33m[done] turns={turns} cost={cost}\033[0m", flush=True)
