# PRD: doom-loop-guard v0.1

**Date:** 2026-11-25 · **Status:** accepted (Shashannk chose "build the memory version now") · **Owner:** Shashannk

## Problem
Coding agents re-apply fixes that already failed. Claude Code users keep filing it (anthropics/claude-code #19699, #27281, plus feature requests for a "circuit breaker" and "loop detection"). The common workaround is a fresh session, which has no record of what failed, so it can repeat the same fixes. Seven existing tools detect loops in a single session; none remember failed fixes across sessions (market research, 2026-11-25).

## Target user
A developer running Claude Code on a real repo who wants it to stop early when stuck, and wants the next attempt (theirs or a fresh agent's) to start from what already failed.

## Success metrics
| Metric | Baseline | Target (14 days after launch) |
| --- | --- | --- |
| GitHub stars | 0 | 150+ (kill under 30) |
| Installs (traffic, issues) | 0 | 50+ |
| False stops in a normal dogfood day | unknown | 0 |

## MVP stories (P0)
1. **Same-error detection.** Errors that differ only in timestamps, line:col, paths, durations, hex ids or colours hash the same; different messages, exit codes or assertion values hash differently. A new fix that fails the same way still counts.
2. **Warn at 2 with the attempts list.** The warning names the count, the error, and the last 5 changes already tried for it.
3. **Stop at 3.** The session halts (verified in a real `claude -p` run) and LOOP-REPORT.md is written first.
4. **Failed-fix memory.** Edits made between two identical failures are stored per project. A new session is briefed on unresolved failures (only ones that repeated or had a fix tried). Re-applying a stored change triggers a warning (or a one-time block in `block` mode). A passing run of the same command marks it fixed.
5. **File thrash.** 6 edits to one file while the error is unchanged stop the session; warning at 5.
6. **Off switch and warn mode.** `DOOM_LOOP_GUARD=off`, `.doom-loop-guard-off`, `mode: "warn"`; bad config falls back to defaults; the hook never crashes a session.

## Later
- Detect A→B→A edit ping-pong without a tool error (v0.2).
- Per-test fingerprints from Jest/pytest summaries instead of whole output (v0.2).
- Expire memory when the touched file changes a lot (v0.2).
- Token or cost budgets (needs transcript parsing).
- Cursor and Codex ports.

## Out of scope
- AI-written summaries (needs an API key; breaks "no network").
- Dashboards or telemetry.

## Decided
- Name: `doom-loop-guard`, the same as the repo (decided 2026-11-26). "loopguard" is taken by another product, and the working name `already-tried` was dropped so there is one name everywhere.
- `repeatFix` defaults to `warn`, not `block`: a real run showed a correct-but-insufficient fix being blocked.
