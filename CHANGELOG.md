# Changelog

## 0.1.0 (unreleased)

- Same-error detection with a normalized error hash: warn at 2, stop at 3.
- Failed-fix memory across sessions: edit fingerprints, next-session briefing, warning before re-applying a failed change.
- File-thrash rule: warn at 5 edits, stop at 6 while the error is unchanged.
- LOOP-REPORT.md with a paste-ready prompt for a fresh session.
- Same-command counter: the same command failing 6 times in a row stops the session, whatever the error says (warn at 4).
- Failures hidden behind `; echo "EXIT:$?"` are recovered and counted.
- Secret redaction, lock files for parallel hooks, ignore list for normal checks, 30-minute repeat window.
- `.already-tried.json` (and `~/.claude/already-tried.json`) config, warn mode, and off switches.
