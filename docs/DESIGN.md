# Design: doom-loop-guard v0.1

## Shape
One entry script, `scripts/guard.js`, handles every hook event: it reads the event JSON on stdin, loads config and state, calls the pure decision logic in `lib/engine.js`, writes state, and prints a JSON decision. It always exits 0.

| Module | Job |
| --- | --- |
| `lib/normalize.js` | Error normalization and hashing; edit (diff) fingerprints. |
| `lib/engine.js` | Pure handlers per event; returns `{ output, memoryChanged, stop }`. |
| `lib/store.js` | Session state (temp dir, per session) and project memory (`.claude/doom-loop-guard/memory.json`), atomic writes, pruning. |
| `lib/report.js` | LOOP-REPORT.md renderer. |
| `lib/config.js` | Defaults + `.doom-loop-guard.json` + env, never throws. |

## Facts verified against Claude Code 2.1.332 (real runs, 2026-11-25)
- A Bash command that exits non-zero arrives as `PostToolUseFailure` with `error` = `"Exit code N\n<output>"`.
- A successful Edit arrives as `PostToolUse` with `tool_input.old_string` / `new_string`.
- `continue: false` is honored on `PostToolUse` and `PreToolUse`, but **ignored on `PostToolUseFailure`**. So a loop found on a failure sets `haltPending`, tells Claude via `additionalContext` to stop, and the next `PreToolUse` returns `continue: false` + deny. A new user prompt clears `haltPending`.
- `SessionStart` `additionalContext` reaches the model (Claude quoted the briefing back in a test run).
- `CLAUDE_PROJECT_DIR` is set for hooks; `CLAUDE_PLUGIN_DATA` is not, so session state falls back to the OS temp dir.

## Attempts bookkeeping
Session state keeps `pendingEdits` (edits since the last failure) and `lastErrorHash`. On a failure with hash H: if `lastErrorHash === H`, the pending edits are stored as failed attempts for H (deduped by diff hash). Pending edits are then cleared. If the hash changed, the file-thrash counters reset.

## Normalizer
ANSI → removed; ISO and clock timestamps → `<TS>`; UUIDs → `<UUID>`; `0x…` and mixed hex ≥ 8 chars → `<HEX>`; absolute paths → basename; durations → `<DUR>`; `:line:col` and `line N` → `<N>`; whitespace collapsed. Exit codes and assertion values are kept on purpose, so progress (a changed value) is not mistaken for a loop.

## v0.2 additions (2026-11-26)

PRD: [docs/product/v0.2-enterprise-loop-control.md](product/v0.2-enterprise-loop-control.md).

| Piece | Where | Notes |
| --- | --- | --- |
| Rewrite churn | `engine.rewriteChurn` (PostToolUse Write) | Counts only `tool_response.type === "update"`, which was verified live. If that is missing, it uses the existence check from `noteWriteTarget` at PreToolUse. |
| Identical calls | `engine.checkSameCall` (PreToolUse) | sha1 of the tool name plus the input with sorted keys. Any different call resets it, and ignored commands reset it too. |
| Budgets | `engine.checkBudget` (PreToolUse), `lib/budget.js` | `guard.js` reads the transcript incrementally (offset, 128-byte head, 64 recent message ids, 8 MB chunks) before calling the pure engine. Stops fire at each multiple of the limit. |
| Pre-tool stops | `engine.preStop` | `continue:false` plus `permissionDecision: deny`. Both are honored on PreToolUse. |
| Policy | `config.findPolicy` | The first system path that exists wins, even if broken. Otherwise `DOOM_LOOP_GUARD_POLICY`. Applied last. `lock` disables the off switches and user or repo `mode`. |
| Audit | `lib/audit.js`, `scripts/stats.js` | Handlers return `events`, and `guard.js` appends one JSONL record per event after the decision. Each write is in its own try/catch. |

Measured: on a 20 MB transcript, the first three hook calls take 9 to 30 ms while they catch up in 8 MB chunks. Later calls take under 2 ms in-process, and a whole hook process takes about 36 ms.

## v0.3 additions (2026-11-26)

PRD: [docs/product/v0.3-toolchain-coverage.md](product/v0.3-toolchain-coverage.md).

| Piece | Where | Notes |
| --- | --- | --- |
| Diagnostics fingerprint | `toolchain.signature`, called from `engine.failureFingerprint` | It is used for shell tools when (a) the command is a build, compile, type-check or lint command, or the text has build-log markers, or it is Unreal, and (b) at least one diagnostic has a location or an error code. Without a build command or build markers, at least one diagnostic must have an error code. The key is the exit code plus the sorted, unique canonical lines (at most 500), each with its count when above 1. At most 5,000 diagnostics are examined. Otherwise the v0.2 path runs. |
| Canonical diagnostic | `toolchain.canon` | `<last 3 path segments>: <error\|fatal error> <CODE>: <message>`. The message goes through `normalize`, plus `file(12,5)` and `[Line: N]` stripping. Capped at 300 characters. Severity words are mapped to English, so a localised compiler matches. |
| Line patterns | `toolchain.PATTERNS`, `matchUnreal` | They are tried in order on each line that passes a cheap prefilter. Lines are cut to 4,000 characters first. Task-runner prefixes are retried once. rustc `error[E…]` takes its file from the following `-->` line. MSVC warnings are kept only if the output says warnings are treated as errors. |
| Generic normalizer | `normalize.RULES` | New rules cover the Unreal log prefix, buildx step timings, `[n/m]` progress, code-frame gutters, rust thread ids, jest and vitest time summaries, `file(12,5)` locations (source extensions only), gcc and clang temp objects, and Unreal unity file numbers. Over 50 KB, it keeps the first 10 KB and the last 40 KB. |
| Environment hints | `toolchain.envHints`, `engine.withHints` | A table of regexes. Each hint fires once per session (`state.warned['hint:<id>']`) and is merged into whatever the failure returns. It is never added to a stop. |
| Build timeouts | `engine.onFailure` (`timedOutBuild`) | The same-error count is reset and not acted on. The same-command count still runs. |
| Silent failures | `toolchain.silentFailure`, `engine.onPostBash` | Only for UnrealEditor(-Cmd) automation runs, and only on `Result={Fail}` or `TEST COMPLETE. EXIT CODE: N` with N > 0. It reuses the masked-exit-code path. |
| Generated files | `toolchain.generatedFile`, `engine.generatedEdit` (PreToolUse) | Path patterns only. No file reads in the engine. |
| PowerShell | `engine.SHELL_TOOLS`, `hooks.json` | Treated like Bash everywhere. |

Measured: a whole hook process takes 68 ms on a 1 MB build log, 137 ms on 6 MB and 284 ms on 19 MB, with the error on the last line. The hook timeout is 10 s.

Compatibility: `test/fixtures/compat-v0.2.json` freezes the v0.2 hash of 21 ordinary outputs, and a test fails if any of them changes.
