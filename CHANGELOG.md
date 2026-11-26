# Changelog

## 0.2.0 (unreleased)

- Rewrite churn: warns when the same existing file is fully rewritten with Write 3 times in a session (`rewriteChurn`, optional stop).
- Identical calls: the same tool call with the same input 5 times in a row warns, and 10 stops, even with no error (`sameCall`).
- Session budgets for tokens (read incrementally from the transcript) and tool calls (`budget`). Off by default; each further stop comes at the next multiple of the limit.
- Admin policy file next to Claude Code's managed-settings.json. It wins over user and repo config. With `"lock": true`, the off switches and warn mode are ignored.
- Local JSONL audit log of every warning, block and stop, rotated at 10 MB, plus `scripts/stats.js` to summarize it.
- `docs/ENTERPRISE.md` with managed-settings examples for force-enabling the plugin.

## 0.1.0 (unreleased)

- Same-error detection with a normalized error hash: warn at 2, stop at 3.
- Failed-fix memory across sessions: edit fingerprints, next-session briefing, warning before re-applying a failed change.
- File-thrash rule: warn at 5 edits, stop at 6 while the error is unchanged.
- LOOP-REPORT.md with a paste-ready prompt for a fresh session.
- Same-command counter: the same command failing 6 times in a row stops the session, whatever the error says (warn at 4).
- Failures hidden behind `; echo "EXIT:$?"` are recovered and counted.
- Secret redaction, lock files for parallel hooks, ignore list for normal checks, 30-minute repeat window.
- `.doom-loop-guard.json` (and `~/.claude/doom-loop-guard.json`) config, warn mode, and off switches.
