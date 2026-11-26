# already-tried

**Your coding agent forgets what didn't work. This remembers.**

A free Claude Code plugin. When Claude keeps hitting the same error, `already-tried`:

1. **Warns** it on the 2nd repeat and lists the changes it already tried for that error.
2. **Stops** the session on the 3rd repeat and writes `LOOP-REPORT.md`: what failed, what was tried, and a prompt you can paste into a fresh session.
3. **Remembers** the failed fixes. The next session in the same project is told up front what already failed, and Claude is warned if it starts to re-apply one of those changes.

Other loop guards stop the agent and then forget. The usual workaround for a stuck agent is "start a new chat", and a new chat has no idea what already failed. This is the part `already-tried` fixes.

Runs locally. No dependencies, no network, no API key, no model calls.

## Install

Inside Claude Code:

```
/plugin marketplace add Rshashannk/doom-loop-guard
/plugin install already-tried@already-tried
```

Needs Node.js 20+ (already there if you installed Claude Code with npm).

## What it catches

| Signal | How | Default |
| --- | --- | --- |
| Same error again | Each failing tool call's error is normalized (timestamps, line numbers, paths, durations, hex ids and colours removed) and hashed. A different fix that fails the same way still counts. | warn at 2, stop at 3 |
| Same command failing in a row | The same command keeps failing even though the message changes each time (a renamed variable, a random id). Catches "fixes" that only change the error text. A failure hidden behind `; echo "EXIT:$?"` still counts. | warn at 4, stop at 6 |
| Same fix again | Each edit is fingerprinted (file + old/new text, whitespace-insensitive). Edits made between two identical failures are recorded as "tried, did not fix it". | warn before re-applying, in this or any later session |
| File thrash | One file edited over and over while the error never changes. | warn at 5, stop at 6 |
| Fixed | When the failing command later passes, the failure is marked fixed and forgotten. | always |

A failure is only remembered across sessions if it repeated or had a fix tried against it, so one-off typos don't pile up. Memory expires after 14 days.

## What Claude sees

On the 2nd repeat:

```
[already-tried] This is the 2nd time this exact error came back: AssertionError: expected 200, received 401.
Changes already tried that did not fix it on their own: 1) auth.js: `if (!token) return deny()` → `if (token == null) return deny()`.
Before trying again, state a different hypothesis for the root cause.
```

At the start of the next session:

```
[already-tried] Earlier sessions in this project hit failures that are still unresolved. Do not repeat fixes that already failed:
1. `npm test -- auth` failed 3 times (last 2026-11-25) with: AssertionError: expected 200, received 401
   Already tried, did not fix it on its own: 1) auth.js: `if (!token) return deny()` → `if (token == null) return deny()`; 2) auth.js: `jwt.verify(token, SECRET)` → `jwt.verify(token.trim(), SECRET)`
```

See a full [example LOOP-REPORT.md](examples/LOOP-REPORT.example.md).

## Configure

Optional `.already-tried.json` in your project root:

```json
{
  "mode": "stop",
  "sameError": { "warn": 2, "stop": 3 },
  "fileThrash": { "warn": 5, "stop": 6 },
  "sameCommand": { "warn": 4, "stop": 6 },
  "windowMinutes": 30,
  "ignoreCommands": ["^make smoke"],
  "repeatFix": "warn",
  "briefing": true,
  "memoryDays": 14,
  "report": true,
  "reportFile": "LOOP-REPORT.md"
}
```

- `mode: "warn"` never stops the session; it keeps warning and still writes the report.
- `repeatFix`: `"warn"` (default) tells Claude before it re-applies a failed change, `"block"` denies it once per session (Claude can repeat the edit to override), `"off"` disables it. A change that didn't fix an error on its own can still be part of the real fix, which is why the default only warns.
- `ignoreCommands`: extra regexes for commands whose failures are normal. Checks such as `grep`, `test -f`, `which` and `curl localhost` are ignored by default (`"useDefaultIgnore": false` turns that off).
- `windowMinutes`: a repeat only counts if the previous one was this recent.
- A user-wide `~/.claude/already-tried.json` works too; the project file wins.
- Turn it off: `ALREADY_TRIED=off` in the environment, or an empty `.already-tried-off` file in the project. `ALREADY_TRIED=warn` forces warn mode.

Files it writes in your project: `LOOP-REPORT.md` (on a stop) and `.claude/already-tried/memory.json`. Add them to `.gitignore` if you don't want them committed, or commit the memory file so your team shares it.

## How it works

One small Node script handles five Claude Code hook events:

| Event | What it does |
| --- | --- |
| `SessionStart` | Briefs a new session on unresolved failures from earlier sessions. |
| `UserPromptSubmit` | Notes the task, for the report. |
| `PostToolUseFailure` | Hashes the error, counts repeats, records the edits that didn't fix it, warns or stops. |
| `PostToolUse` (Edit, Write, Bash) | Fingerprints edits, counts file thrash, marks failures fixed when the command passes. |
| `PreToolUse` | Warns before re-applying a failed change; delivers the stop. |

Claude Code ignores `continue: false` from `PostToolUseFailure` hooks (checked on 2.1.332), so on the 3rd repeat the plugin tells Claude a loop was detected and halts the session on the next tool call. Any error inside the hook is swallowed and logged, so the plugin can't break a session. Secrets (API keys, tokens, passwords) are redacted before anything is stored. Every edge case we know of is listed, with its test, in [docs/EDGE-CASES.md](docs/EDGE-CASES.md).

## Alternatives

Loop detection itself is not new, and these are worth a look:

- [loop-detective](https://github.com/YeonwooSung/my-claude-code-mods) — observes repeated Bash failures and shows them in a pane.
- [LoopDetector](https://github.com/ktripathi2281/LoopDetector) — a scored, multi-signal detector with a Rethink button.
- [LoopGuard](https://tryloopguard.com) — repeat-call and spend limits for Claude Code, Codex and Cursor.
- [failproofai](https://github.com/FailproofAI/failproofai) — a large library of hook policies.

`already-tried` is the one that remembers failed fixes across sessions and writes them down.

## Develop

```
npm test                         # node:test, no dependencies
claude --plugin-dir .            # load the plugin from a checkout
```

## License

MIT
