#!/usr/bin/env python3
import json
import os
import re
import sys
import time
from pathlib import Path


def wait_for_stable(path: Path, max_wait: float = 2.0, interval: float = 0.1) -> None:
    deadline = time.monotonic() + max_wait
    last_size = -1
    while time.monotonic() < deadline:
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            return
        if size == last_size:
            return
        last_size = size
        time.sleep(interval)


def kebab(s: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s or "untitled"


def render(transcript_path: Path, repo_root: Path) -> None:
    events = []
    with transcript_path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    title = None
    session_id = None
    for e in events:
        if e.get("type") == "ai-title" and e.get("aiTitle"):
            title = e["aiTitle"]
        if not session_id:
            session_id = e.get("sessionId")

    blocks = []
    for e in events:
        t = e.get("type")
        msg = e.get("message") or {}
        role = msg.get("role")
        content = msg.get("content")

        if t == "user" and role == "user" and isinstance(content, str) and content.strip():
            blocks.append(f"## User\n\n{content.strip()}\n")
        elif t == "assistant" and role == "assistant" and isinstance(content, list):
            parts = []
            for block in content:
                bt = block.get("type")
                if bt == "text":
                    text = (block.get("text") or "").strip()
                    if text:
                        parts.append(text)
                elif bt == "tool_use":
                    name = block.get("name", "?")
                    inp = block.get("input", {}) or {}
                    brief = (
                        inp.get("command")
                        or inp.get("file_path")
                        or inp.get("description")
                        or inp.get("pattern")
                        or ""
                    )
                    if isinstance(brief, str) and len(brief) > 100:
                        brief = brief[:100] + "..."
                    parts.append(f"> {name}: {brief}".rstrip(": ").rstrip())
            text = "\n\n".join(parts)
            if text:
                blocks.append(f"## Assistant\n\n{text}\n")

    header = f"# Session: {title or session_id or 'unknown'}\n\n"
    body = header + "\n".join(blocks)

    logs = repo_root / "logs"
    logs.mkdir(exist_ok=True)

    name = kebab(title) if title else (session_id or "unknown")
    out = logs / f"{name}.md"

    if title and session_id:
        old = logs / f"{session_id}.md"
        if old.exists() and old != out:
            old.unlink()

    out.write_text(body)


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return

    transcript = payload.get("transcript_path")
    if not transcript:
        return
    transcript_path = Path(transcript)
    if not transcript_path.exists():
        return

    wait_for_stable(transcript_path)

    repo_root = Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    render(transcript_path, repo_root)


if __name__ == "__main__":
    main()
