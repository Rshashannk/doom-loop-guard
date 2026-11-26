# Edge cases

Every case we found, what already-tried does, and the test that proves it. Test ids refer to `test/edge.test.js` (E..) and `test/guard.test.js` / `test/normalize.test.js` (named). "Verified live" means checked in a real Claude Code 2.1.332 session, not only in unit tests.

## Detection: what counts as a loop

| # | Case | Behaviour | Proof |
| --- | --- | --- | --- |
| 1 | Same error with different line numbers, timestamps, paths, durations, hex ids, colours | Same fingerprint, counts as a repeat | normalize tests |
| 2 | A *different* fix that fails with the same error | Still counts (counter is per error, not per change) | "a new fix that fails the same way" |
| 3 | A "fix" that only changes the error text (renamed variable, shuffled message) | Second counter: same command failing in a row, warn at 4, stop at 6, whatever the message says | E01 |
| 4 | Fixing many compile errors one by one (new error every run) | Treated as possible progress: a warning at 4 and 5, no stop before 6 | E03 |
| 5 | Different errors that alternate (A, B, A, B, A) | Each error counted separately; stops at A's 3rd | "different errors do not add up" + same-error rule |
| 6 | Failure with no output, only "Exit code 1" | Command is mixed into the fingerprint, so silent failures of different commands never look alike | E04 |
| 7 | Different missing files (Read on a/index.js, b/index.js) | Target path is part of the fingerprint for non-shell tools | E05 |
| 8 | Exit code changes (1 vs 2) or an assertion value changes (got 41 vs got 43) | Different fingerprint: a changed value can be progress | normalize tests |
| 9 | grep/diff "no match" | Claude Code reports these as success, so they never reach us | verified live |
| 10 | Checks that are meant to fail sometimes (`test -f`, `which`, `pgrep`, `curl localhost` while a server boots, `sleep`) | Ignored by default; list is configurable (`ignoreCommands`, `useDefaultIgnore`) | E07, E08 |
| 11 | User rejects a tool call | Not a failure | E06 |
| 12 | A call blocked by a PreToolUse hook (ours or another) | Claude Code does not send a failure event for it; our own messages are also filtered | verified live, E06 |
| 13 | Interrupted call (Esc) | Ignored | "interrupted calls are ignored" |
| 14 | Command timeouts | Normal failure; duration is stripped so repeats match | verified live |
| 15 | An error that comes back much later (lint at 10:00 and again at 11:30) | Count restarts if the last repeat was over 30 min ago (`windowMinutes`) | E09 |
| 16 | `cd dir && cmd 2>&1 \| tail -50` vs `cmd` | Treated as one command | E10 |
| 16b | Agent hides the failure itself: `node test.js; echo "EXIT:$?"` exits 0, so Claude Code reports success | The echoed exit status is read back from the output and the run counts as a failure of `node test.js` (an echoed 0 counts as a pass) | verified live (Claude did exactly this), E34–E36 |
| 17 | Edit failing with "string not found" | Claude Code validates this before running the tool and sends no failure event, so it is invisible to every hook-based guard | verified live (known limit) |

## Memory: failed fixes across sessions

| # | Case | Behaviour | Proof |
| --- | --- | --- | --- |
| 18 | A fix that was correct but not enough on its own | Default only warns (never blocks), and the wording says it may still be part of the fix | verified live, "repeat fix (default warn)" |
| 19 | Claude insists on a blocked fix (`repeatFix: "block"`) | Blocked once per session; the same edit again goes through | "repeat fix (block)" |
| 20 | Same warning on every retry | Shown once per change per session | E15 |
| 21 | Same edit in two files with the same name | Fingerprint uses the project-relative path, so no collision | E12 |
| 22 | Formatting-only edits, docs edits, edits to our own files | Not recorded as attempts | E13 |
| 23 | Write (whole file) and MultiEdit | Fingerprinted and summarised | E14 |
| 24 | Edits before any failure | Not attempts, not thrash | E16 |
| 25 | The failure gets fixed | Same command passing, or a broader one (`npm test` covers `npm test -- auth`), marks it fixed and forgets it | E11, "a passing run…" |
| 26 | One-off failures (a typo) | Remembered but never briefed: only repeated failures or ones with a tried fix are | "a single one-off failure…" |
| 27 | Stale memory from weeks ago | Expires after 14 days (`memoryDays`); capped at 50 failures and 20 attempts each | E30 |
| 28 | Many failures at once | Briefing capped at 5 items and 2,400 characters | E29 |
| 29 | Team shares memory.json via git | Paths are project-relative so it works on any machine; a merge conflict is moved aside as `memory.json.corrupt-*` | E21 |
| 30 | Hand-edited memory with wrong types | Bad entries dropped, never crashes | E22 |
| 31 | Code changed since the failure (it may already be fixed) | Briefing tells Claude to reproduce first; a passing run clears it | briefing text |

## Stopping

| # | Case | Behaviour | Proof |
| --- | --- | --- | --- |
| 32 | `continue: false` is ignored on PostToolUseFailure | Loop flagged on the failure, Claude told to stop, the next tool call is halted | verified live, S1–S3 test |
| 33 | Claude ends its turn instead of calling another tool | Nothing to halt; the pending stop is cleared by the next user message | "a new user prompt cancels…" |
| 34 | `claude --resume` after a stop | Pending stop cleared, first tool call runs | E27 |
| 35 | After a stop the user says "keep going" | Counters restart, so it warns again before stopping again | "after a stop, resuming…" |
| 36 | `/clear` and auto-compact | `/clear` resets counters; compact keeps them and re-briefs | E28 |
| 37 | Warn mode | Never halts; keeps warning, still writes the report | S6 test |
| 38 | File thrash in warn mode | Warns at 5, 6, then every 3rd edit, not on every edit | E17 |

## Report

| # | Case | Behaviour | Proof |
| --- | --- | --- | --- |
| 39 | A LOOP-REPORT.md you wrote yourself already exists | Not overwritten; report goes to `.claude/already-tried/LOOP-REPORT.md` and the stop message says so | E24 |
| 40 | Error text with ``` fences, pipes, control or terminal escape characters | Longer fence, escaped table cells, control chars stripped | E19 |
| 41 | Secrets in commands or errors (API keys, GitHub/Slack/AWS tokens, JWTs, `password=`, `Bearer`) | Redacted before anything is stored, briefed or reported | E18 |
| 42 | `reportFile` set to an absolute path or `../` | Rejected, default used | E32 |

## Robustness

| # | Case | Behaviour | Proof |
| --- | --- | --- | --- |
| 43 | Broken or empty JSON on stdin, non-object input | No output, exit 0 | "bad stdin…", E25 |
| 44 | Any exception inside the hook | Logged to the state folder, exit 0: the plugin can never break a session | guard.js |
| 45 | Read-only project folder or full disk | Warnings still returned; failed writes are logged | E23 (skipped when tests run as root) |
| 46 | Missing `session_id` or a missing project folder | Falls back to the transcript path / parent process, and to the working directory | E25 |
| 47 | Parallel tool calls running the hook at the same time | Lock file around every read-modify-write; stale locks (crashed hook) expire after 10 s; never waits more than ~1.5 s | E31 |
| 48 | Subagents (same session id) | Counted separately by `agent_id` | E26 |
| 49 | Huge outputs (MBs) | Input capped at 20 MB, normalisation at 50 KB; a 5 MB error takes well under a second | E20 |
| 50 | Bad config (invalid JSON, negative numbers, bad regex, unknown keys) | Each bad value falls back to its default | E32, "custom thresholds…" |
| 51 | Global settings for all projects | `~/.claude/already-tried.json`, overridden by the project file | E32 |
| 52 | Turning it off | `ALREADY_TRIED=off` (also `0`, `false`, `no`, any case) or a `.already-tried-off` file | S6 test, E32 |
| 53 | Old session files piling up in temp | Deleted after 7 days on session start | store.pruneSessions |
| 54 | Speed | About 35 ms per hook call (median, Linux); runs on every tool call because of the stop workaround | measured |
| 55 | Windows paths and line endings | Backslash paths normalised, CRLF handled; CI runs on Windows, macOS and Linux | normalize tests, CI matrix |

## Known limits (not fixable from a hook)

- Edit validation failures ("string not found") never reach hooks (#17).
- Loops that never produce a tool error, such as the model repeating "let me write the file" without calling a tool, are invisible to tool hooks.
- A command whose output is genuinely random every run (random seeds in messages) defeats the same-error rule; the same-command counter still catches it at 6.
- `cmd || true` and similar masks that don't print the exit status can't be recovered.
- Node.js must be on the PATH where Claude Code runs hooks.
