# Rolling out doom-loop-guard to a team

doom-loop-guard is free (MIT), has no dependencies, makes no network calls and needs no account. Everything below uses Claude Code's own managed settings, plus one policy file that this plugin reads.

## What you get

| Need | How |
| --- | --- |
| Every developer runs it, and they can't remove it | The plugin is force-enabled in managed settings |
| The same limits for everyone, and a repo can't turn them off | `doom-loop-guard.json` policy file with `"lock": true` |
| Each session has a bound, even when nothing errors | `budget.tokens`, `budget.toolCalls`, `sameCall` |
| A record of every loop that was caught | Local JSONL audit log, summarized with `scripts/stats.js` |
| No data leaves the machine | Nothing is ever sent. Secrets are redacted before anything is written |

This bounds a **single session**. Claude Code's org, group and member spend limits bound the **month**. Use both.

## 1. Install it for everyone

Put this in Claude Code's managed settings (`examples/enterprise/managed-settings.plugin.json`):

| OS | File |
| --- | --- |
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux and WSL | `/etc/claude-code/managed-settings.json` |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json` |

```json
{
  "extraKnownMarketplaces": {
    "doom-loop-guard": {
      "source": { "source": "github", "repo": "Rshashannk/doom-loop-guard" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "doom-loop-guard@doom-loop-guard": true },
  "allowManagedHooksOnly": true
}
```

`enabledPlugins: true` in managed settings force-enables the plugin. `allowManagedHooksOnly` blocks every other user, project and plugin hook. Plugins force-enabled in managed settings are exempt from that block, so this one keeps running. To stop users adding other marketplaces, also set `strictKnownMarketplaces` to the list of sources you allow. Use `disableSideloadFlags` to block `--plugin-dir`.

To pin a reviewed version instead of auto-updating, fork the repo, point `repo` at your fork, and set `"autoUpdate": false`.

**No GitHub access on the machines?** Copy the repo to a fixed path such as `/opt/doom-loop-guard`, and use `examples/enterprise/managed-settings.hooks.json` instead. It registers the same five hooks directly in managed settings. Node.js 20+ must be on `PATH`.

## 2. Set the policy

Put `doom-loop-guard.json` next to `managed-settings.json` (same folder as above). A starting point is in `examples/enterprise/doom-loop-guard.policy.json`:

```json
{
  "lock": true,
  "mode": "stop",
  "rewriteChurn": { "warn": 3, "stop": 6 },
  "sameCall": { "warn": 5, "stop": 10 },
  "budget": {
    "tokens": { "warn": 2000000, "stop": 4000000 },
    "toolCalls": { "warn": 400, "stop": 800 }
  },
  "auditFile": "/var/log/doom-loop-guard/audit.jsonl"
}
```

The budget numbers are placeholders, not recommendations. See step 4 for how to choose yours.

How the layers combine:

1. Built-in defaults.
2. `~/.claude/doom-loop-guard.json` (the user).
3. `.doom-loop-guard.json` (the repo).
4. **The policy file, which wins over all of the above.**

With `"lock": true`:
- `DOOM_LOOP_GUARD=off` and `DOOM_LOOP_GUARD=warn` are ignored.
- An empty `.doom-loop-guard-off` file is ignored.
- `mode` set by a user or a repo is ignored.
- A repo can't set `audit: false`.

Keys the policy leaves out can still be changed by users and repos. Set every key you want to enforce.

If the policy file is broken JSON, the defaults apply and the error is not fatal. A broken system file still blocks the `DOOM_LOOP_GUARD_POLICY` env path. That env var is only read on machines with no system file, so it is for CI and tests.

## 3. The rules

| Rule | Catches | Default |
| --- | --- | --- |
| `sameError` | The same normalized error again | warn 2, stop 3 |
| `sameCommand` | The same command failing in a row, whatever the message says | warn 4, stop 6 |
| `fileThrash` | One file edited again and again while the error doesn't change | warn 5, stop 6 |
| `repeatFix` | Re-applying a change that already failed (this or an earlier session) | warn |
| `rewriteChurn` | The same existing file fully rewritten with Write | warn 3, stop off |
| `sameCall` | The exact same tool call with the same input, in a row, even when it succeeds | warn 5, stop 10 |
| `budget.tokens` | Tokens used by the session: input + cache writes + output, with cache reads not counted | off |
| `budget.toolCalls` | Tool calls made by the session | off |

A `0` turns a warn or stop level off. After a budget stop, if the user tells the agent to carry on, the next stop comes at 2× the limit, then 3×, and so on.

Hooks receive no token data, so tokens are read from the session transcript. Only the new bytes are read on each call. The transcript is written a moment after each model turn, so the count can lag by about one turn.

## 4. Choosing budgets

There is no universal right number. Measure your own team first:

1. Roll out with `"mode": "warn"` and only the `warn` levels set, for a week.
2. Run `node scripts/stats.js /var/log/doom-loop-guard/audit.jsonl` to see which rules fire and how many tokens sessions had used at that point.
3. Set `stop` well above what normal sessions reach, then switch to `"mode": "stop"`.

For scale: Anthropic's docs put the average Claude Code cost at about $13 per developer per active day, and under $30 for 90% of users.

## 5. The audit log

Each warning, block and stop is written as one JSON line:

```json
{"ts":"2026-11-26T12:37:41.981Z","kind":"stop","rule":"rewrite-churn","why":"config.js was fully rewritten 5 times in this session","session":"eb8315a9-…","project":"/home/dev/app","tokens":25990,"toolCalls":6,"mode":"stop","version":"0.2.0"}
```

- The default location is `~/.claude/doom-loop-guard/audit.jsonl`. The policy or the user config can set `auditFile` (an absolute path). A repo can't.
- The log rotates at 10 MB and keeps one old file (`audit.jsonl.1`).
- If the file can't be written, the warning still reaches Claude. The error goes to the plugin's `errors.log`.
- Collect it with the log agent you already run, or summarize it with `node scripts/stats.js [file] [--since 2026-11-01]`.

Nothing in the log contains code or prompts. It holds the rule, counts, the project path and a short redacted reason.

## 6. What it can't see

- **Edit failures that never reach hooks**, such as "string not found", or "File has been modified since read" inside subagents. The token and tool-call budgets still bound these.
- **Loops with no tool calls**, where the model only talks. Use `--max-turns` or `--max-budget-usd` for headless runs.
- **Failures masked with `|| true`.**
