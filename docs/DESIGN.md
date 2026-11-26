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
