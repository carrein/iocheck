# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Claude Code working directory with a project-local `.claude/` config. It is not a software project — there is no build, lint, or test toolchain. The only executable code is `.claude/render-session.py`.

`.envrc` sets `CLAUDE_CONFIG_DIR="$PWD/.claude"` (direnv), so Claude Code uses the in-repo config, sessions, skills, and history rather than the user-global `~/.claude`. Run `direnv allow` after cloning.

## Layout

- `.claude/settings.json` — the only Claude Code config that is tracked. Currently registers a single `Stop` hook.
- `.claude/render-session.py` — the Stop-hook script. Tracked.
- `.claude/skills/` — symlinks to the user's personal skills under `~/.claude/skills/carrein-*`. Not tracked (excluded by `.gitignore`); recreate by symlinking if missing.
- `.claude/` everything else (sessions, history, plugins, backups, shell snapshots) — runtime state, ignored by `.gitignore`.
- `logs/` — markdown transcripts produced by the Stop hook, one file per session.

## Session renderer hook

`.claude/settings.json` runs `python3 .claude/render-session.py` on every `Stop` event. The script:

1. Reads `transcript_path` from the hook payload on stdin and waits for the JSONL file to stabilize (`wait_for_stable`, max 2s).
2. Walks the events: emits `## User` blocks for plain-text user turns and `## Assistant` blocks for assistant turns, summarizing each `tool_use` block as `> ToolName: <command|file_path|description|pattern>` (truncated at 100 chars).
3. Writes the markdown to `logs/<slug>.md` where the slug is the kebab-cased `aiTitle` if one has been emitted, otherwise the `sessionId`. When a title appears later, the older `<sessionId>.md` file is deleted so each session has exactly one log.

`CLAUDE_PROJECT_DIR` (set by the harness) determines the `logs/` location; it falls back to `cwd`.

When editing the renderer, remember the contract: it must accept the Stop-hook JSON payload on stdin, must not raise on malformed transcripts (the `try/except` around `json.loads` is load-bearing — sessions are read while still being written), and must be idempotent if run twice on the same transcript.
