# Changelog

## 0.3.0 (unreleased)

- Works with any toolchain. Build, compile, type-check and lint failures are fingerprinted by their error diagnostics: file, code and message, sorted. Moved lines, parallel output order, progress lines and timings no longer hide a repeated error. Covered: MSVC, MSBuild, dotnet, gcc, clang, linkers, Make, Ninja, CMake, Bazel, cargo, Go, javac, Kotlin, Gradle, Maven, Swift, tsc, mypy and pyright, plus localised compilers.
- Unreal Engine: UnrealBuildTool, UnrealHeaderTool, RunUAT and editor automation tests, including test runs that exit 0 with failures.
- Fixed for every project: code-frame line numbers (gcc, clang, rustc, jest), `file(12,5)` locations (tsc, MSVC, dotnet), random linker temp files, Rust panic thread ids and jest's "estimated" time all made the same error look new.
- One-time hints when retrying can't help: Live Coding active, a locked output file, out of memory, a full disk (`hints`).
- A warning before editing generated files such as `*.generated.h`, `*.pb.go` and `node_modules/` (`generatedFiles`).
- A build that hits the shell timeout no longer counts as a repeated error.
- Huge logs: the whole output is scanned for diagnostics, and the generic normalizer keeps the end of long output, where the error usually is.
- Windows: the PowerShell tool, `$LASTEXITCODE`, `%ERRORLEVEL%`, `Select-Object -Last` and `tee` are handled.
- Monorepos: the same error in several packages, or several times in one file, is counted per occurrence, so fixing one is progress. ESLint, clippy and webpack formats are recognised.
- Ordinary output keeps its v0.2 fingerprint. `fingerprint: "legacy"` restores v0.2 hashing.

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
