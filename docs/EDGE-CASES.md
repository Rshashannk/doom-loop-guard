# Edge cases

Every case we found, what doom-loop-guard does, and the test that proves it. Test ids refer to `test/edge.test.js` (E..) and `test/guard.test.js` / `test/normalize.test.js` (named). "Verified live" means checked in a real Claude Code 2.1.332 session, not only in unit tests.

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
| 39 | A LOOP-REPORT.md you wrote yourself already exists | Not overwritten; report goes to `.claude/doom-loop-guard/LOOP-REPORT.md` and the stop message says so | E24 |
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
| 51 | Global settings for all projects | `~/.claude/doom-loop-guard.json`, overridden by the project file | E32 |
| 52 | Turning it off | `DOOM_LOOP_GUARD=off` (also `0`, `false`, `no`, any case) or a `.doom-loop-guard-off` file | S6 test, E32 |
| 53 | Old session files piling up in temp | Deleted after 7 days on session start | store.pruneSessions |
| 54 | Speed | About 35 ms per hook call (median, Linux); runs on every tool call because of the stop workaround | measured |
| 55 | Windows paths and line endings | Backslash paths normalised, CRLF handled; CI runs on Windows, macOS and Linux | normalize tests, CI matrix |

## v0.2: rewrites, identical calls, budgets, policy, audit

| # | Case | Handling | Test |
| --- | --- | --- | --- |
| 57 | Write creates a new file | Not churn. Only `tool_response.type: "update"` counts (verified live) | V02 |
| 58 | `tool_response.type` missing | Falls back to whether the file existed at PreToolUse | V03 |
| 59 | Rewrites of docs (.md) | Still counted. The cost is the same whatever the file type | V02 |
| 60 | Our own report or state files rewritten | Never counted | engine `rewriteChurn` |
| 61 | Same call with JSON keys in a different order | Same call (stable key order before hashing) | V06 |
| 62 | Two calls alternating (`cat a`, `npm test`) | Never counted: only consecutive identical calls count | V06 |
| 63 | Polling with `sleep` | Ignored commands neither count nor build a streak | V07 |
| 64 | Claude Code writes one transcript line per content block | Each message id is counted once | V08 |
| 65 | Half-written last transcript line | Left for the next hook call | V08 |
| 66 | Transcript replaced, truncated, or rewritten at the same size | Detected by size and by the first 128 bytes, then counted from zero | V09 |
| 67 | Transcript missing, a directory, or garbage lines | The budget reads 0 for that line or file. The hook never fails | V08, V12 |
| 68 | Transcript of 100+ MB on resume | At most 8 MB read per hook call; the rest is read on later calls | `lib/budget.js` |
| 69 | User says "keep going" after a budget stop | The next stop comes at the next multiple of the limit | V10 |
| 70 | Transcript flushed after the hook runs | The count lags by about one turn (seen in QA). It is acceptable for a bound | ENTERPRISE.md |
| 71 | Policy locked, but `DOOM_LOOP_GUARD=off`, `.doom-loop-guard-off`, or a repo setting `mode: warn` | All ignored | V13 |
| 72 | Policy file is broken JSON | Defaults apply. A broken system file still blocks the env path | V14 |
| 73 | A repo tries to redirect the audit log | Only policy and user config can set `auditFile`. Relative paths are rejected | V15 |
| 74 | Secrets in an error that triggered a stop | Redacted in the audit `why` | V16 |
| 75 | Audit file over 10 MB | Renamed to `.1`, and a new file is started | V17 |
| 76 | Audit path not writable | Logged to errors.log. The warning still reaches Claude | V17 |
| 77 | Tests writing to the real home folder | Every test sets `HOME` to a temp folder | all suites |

## v0.3: toolchains, Unreal, environments

Fixtures: `test/fixtures/toolchains/` holds real output captured from gcc 13, clang 18, GNU make, ninja, Go, cargo, javac, tsc, jest 29 and pytest. `test/fixtures/unreal/` holds logs built by hand from the formats Unreal and MSVC print. Tests are in `test/toolchain.test.js` (T..).

| # | Case | Handling | Test |
| --- | --- | --- | --- |
| 78 | Same compile error after the agent adds or removes lines above it | Code-frame gutters and `file(12,5)` locations are stripped, and build failures use diagnostics only | T same-error ×12 |
| 79 | `make -j` / `ninja` / UBT print parallel errors in a different order | Diagnostics are sorted before hashing | T gcc reordered, UBT |
| 80 | Fixing one of several errors | Different fingerprint: progress | T "fixing one of several" |
| 81 | Random linker temp files (`/tmp/ccXXXXXX.o`, `c-1a2b3c.o`) | Stripped | T GNU ld, generic |
| 82 | Rust panics print a thread id that changes every run | Stripped | T cargo test |
| 83 | jest adds "estimated" to its time line from run 2 on | Time and duration summaries are stripped | T jest |
| 84 | A test log that happens to contain `x.js:12: error: …` | Diagnostics mode needs a build command, build-log markers or an error code, so changing assertions still differ | T false positives |
| 85 | `cargo test` prints only `error: test failed` | Not treated as a diagnostic, so the panic message decides | T cargo test |
| 86 | Unreal UBT: action counts, `[n/m]`, timings, unity files renumbered, engine path | Noise | T UBT, LNK2019 |
| 87 | Unreal recognised from the log behind a wrapper script; a project's own `build.sh` is not Unreal | Command or log markers | T wrapper, build.sh |
| 88 | UnrealHeaderTool `Header.h(24): Error: …` | Diagnostic per header | T UHT |
| 89 | Editor automation: `[2026.11.26-21.45.13:123][ 87]` prefixes, `[Line: 41]` | Stripped. Assertion values are kept | T automation |
| 90 | Editor exits 0 with failed automation tests | Counted as a failure (Unreal editor test runs only) | T silent failure |
| 91 | `RunUAT BuildCookRun` cook errors | `LogCook: Error` lines and `ExitCode=25 (Error_UnknownCookFailure)` | T UAT |
| 92 | Live Coding active, conflicting UBT, locked DLL (LNK1104), out of memory (C1060, exit 137, JS heap), full disk | One hint on the first failure, once per session; `hints: false` turns them off | T hints |
| 93 | A long build hits the shell timeout | Hint; not a repeated error; the same-command stop at 6 still applies. A test that times out still stops at 3 | T timeouts |
| 94 | A build timeout followed by a test timeout with the same message | Counts don't carry over | T timeouts |
| 95 | Editing `*.generated.h`, `Intermediate/`, `*.pb.go`, `node_modules/`, `target/debug/` | One warning per file per session; `generatedFiles: "off"` | T generated |
| 96 | MSBuild `2>` prefixes, `[proj.vcxproj]` suffixes, errors repeated in the summary | Stripped and de-duplicated | T MSBuild |
| 97 | Windows paths with spaces, a different drive or user folder on another machine | Only the file name is kept | T Windows paths |
| 98 | `/WX` and C2220: the warning is the real error | The promoted warnings are kept | T C2220 |
| 99 | Localised compilers | "Error" in 15+ languages, full-width colons | T localised |
| 100 | turbo, pnpm -r, docker compose line prefixes | Stripped before matching | T monorepo, prefixed |
| 101 | Kotlin, Maven, Swift, mypy, Bazel, pyright, Apple ld | Covered by patterns | T formats |
| 102 | A 6 MB to 19 MB build log with the error on the last line | Found. 284 ms for a whole hook process on 19 MB | T huge log, measured |
| 103 | Output over 50 KB that is not a build log | Keeps the head and the tail, so an error at the end still counts | T generic >50k |
| 104 | One 200 KB template-error line; pathological regex input | Lines cut to 4 KB before matching; no backtracking blow-up | T pathological |
| 105 | Thousands of errors | At most 500 diagnostics in a fingerprint | T cap |
| 106 | PowerShell tool, `$LASTEXITCODE`, `%ERRORLEVEL%`, `Select-Object -Last`, `tee` | Same as Bash | T PowerShell, normalization |
| 107 | Upgrading from v0.2 | Ordinary output keeps its exact hash (21-case frozen corpus). A remembered build failure gets a new fingerprint once. `fingerprint: "legacy"` restores v0.2 hashing | T compat, legacy |

## Known limits (not fixable from a hook)

- Edit validation failures ("string not found") never reach hooks (#17).
- Loops with no tool calls at all, such as the model repeating "let me write the file" without calling a tool, are invisible to tool hooks. Loops that do call tools but never error are now bounded by `sameCall` and the budgets.
- A command whose output is genuinely random every run (random seeds in messages) defeats the same-error rule; the same-command counter still catches it at 6.
- `cmd || true` and similar masks that don't print the exit status can't be recovered.
- Node.js must be on the PATH where Claude Code runs hooks.
- A build log in a format we don't know falls back to the generic normalizer. It still handles moved lines in most formats, but not reordered parallel output. Captured logs from new toolchains are the fix: add one as a fixture and a pattern.
- The Unreal, MSVC, MSBuild and Xcode fixtures are built from documented formats, not captured from real builds, because those toolchains can't run in this CI.
- In a live run, Claude Code 2.1.332 moved a timed-out command to the background and sent no failure event. The timeout handling (#93) applies whenever a timeout does arrive as a failure.
