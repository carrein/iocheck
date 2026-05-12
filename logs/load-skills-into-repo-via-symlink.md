# Session: Load skills into repo via symlink

## User

Can you load our skills into this repo by symlink.

## Assistant

> Bash: ls -la /Users/carrein/Desktop/iocheck2/

## Assistant

> Bash: ls -la /Users/carrein/Desktop/iocheck2/.claude/ 2>/dev/null || echo "no .claude dir"

## Assistant

> Bash: ls -la ~/.claude/skills/ 2>/dev/null || echo "no user-level skills dir"

## Assistant

> Bash: ls ~/.claude/skills/carrein-audit/

## Assistant

> Bash: ls /Users/carrein/Desktop/iocheck2/.claude/ 2>/dev/null; echo "---"; ls /Users/carrein/Desktop/ioche...

## Assistant

Found 7 carrein-* skills in `~/.claude/skills/`. I'll create `.claude/skills/` in this repo and symlink them in.

## Assistant

> Bash: mkdir -p /Users/carrein/Desktop/iocheck2/.claude/skills && cd /Users/carrein/Desktop/iocheck2/.claud...

## Assistant

Symlinked all 7 carrein-* skills into `.claude/skills/`. They'll be discoverable next session — restart Claude Code (or reload) for the harness to pick them up.
