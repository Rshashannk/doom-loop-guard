'use strict';
// Pure decision logic. Each handler takes the hook input plus loaded state and
// returns { output, memoryChanged, stop }. No file or network access here.
const path = require('node:path');
const { normalize, hashError, hashDiff, squash, redact, shortHash } = require('./normalize');
const toolchain = require('./toolchain');

const TAG = '[doom-loop-guard]';
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
// Claude Code on Windows can run commands through a PowerShell tool.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// `; echo "EXIT:$?"` and its PowerShell / cmd forms
const ECHO_STATUS = /\s*(?:;|&&|\|\|)\s*(?:echo|Write-(?:Host|Output))\b[^;&|]*(?:\$\?|\$LASTEXITCODE|%ERRORLEVEL%)[^;&|]*$/i;
const BRIEFING_MAX_CHARS = 2400;

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const ordinal = (n) => {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
};
const day = (iso) => String(iso || '').slice(0, 10);
const minutesBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;

// Tool rejections are a person saying no, not the code failing.
const REJECTION = /doesn't want to proceed|user (?:rejected|denied|declined)|was (?:rejected|denied) by the user|permission to use \w+ (?:was|has been) denied|operation was aborted|request (?:was )?interrupted by user/i;

function normalizeCommand(cmd) {
  let c = String(cmd || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const before = c;
    c = c.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '')   // leading `cd dir &&`
      .replace(/\s*2>&1/g, '')
      .replace(/\s*\|\s*(?:tail|head)(?:\s+-n)?(?:\s+-?\d+)?\s*$/, '')
      .replace(/\s*\|\s*(?:cat|less|more|Out-Host|Out-String)\s*$/i, '')
      .replace(/\s*\|\s*(?:tee|Tee-Object)(?:\s+-a)?(?:\s+(?:-FilePath\s+)?\S+)?\s*$/i, '')     // `| tee build.log`
      .replace(/\s*\|\s*Select-Object\s+-(?:Last|First)\s+\d+\s*$/i, '')           // PowerShell tail/head
      .replace(ECHO_STATUS, '')                                                  // `; echo "EXIT:$?"`
      .trim();
    if (c === before) break;
  }
  return redact(c);
}

function isIgnoredCommand(cmd, cfg) {
  return Boolean(cmd) && (cfg.ignore || []).some((re) => re.test(cmd));
}

// The interesting part of an error: drop the "Exit code N" line, keep the first
// line that looks like a message.
function errorExcerpt(err, n = 160) {
  const lines = normalize(err).split('\n').map((l) => l.trim()).filter(Boolean);
  const body = lines.filter((l) => !/^Exit code \d+$/.test(l));
  const pick = body.find((l) => /\b\w*(Error|Exception)\b:|assert|expected|panicked|E\d{3,}/i.test(l))
    || body.find((l) => /error|fail|cannot|not found|denied|no such|refused|timed out/i.test(l))
    || body[0] || lines[0] || '';
  return clip(pick, n);
}

// A few meaningful lines of the error, for the report.
function errorDetail(err) {
  const lines = normalize(err).split('\n').map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^Exit code \d+$/.test(l.trim()));
  return lines.slice(0, 8).join('\n').slice(0, 700);
}

// Is there anything in the error besides the exit code? "Exit code 1" alone
// would make every silent failure look like the same error.
function errorIsBare(err) {
  const body = normalize(err).split('\n').map((l) => l.trim())
    .filter((l) => l && !/^Exit code \d+$/.test(l)).join(' ');
  return body.replace(/[^A-Za-z]/g, '').length < 12;
}

function relPath(file, projectDir) {
  if (!file) return '';
  const abs = path.resolve(projectDir || '.', file);
  const rel = projectDir ? path.relative(projectDir, abs) : abs;
  const r = !rel || rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel;
  return r.split(path.sep).join('/');
}

function firstChangedLine(oldText, newText) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || '').trim() !== (b[i] || '').trim()) return [clip(a[i] || '', 50), clip(b[i] || '', 50)];
  }
  return [clip(a[0], 50), clip(b[0], 50)];
}

const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;

// One fingerprint + human summary per edit tool call. `skip` marks edits that
// should not count as an attempt at a fix.
function describeEdit(toolName, input, projectDir, cfg) {
  const file = input.file_path || input.notebook_path || '';
  const key = relPath(file, projectDir);
  const base = key.split('/').pop() || '(unknown file)';
  let res;
  if (toolName === 'Write') {
    const content = String(input.content == null ? '' : input.content);
    const lines = content ? content.split('\n').length : 0;
    res = { file: key, diffHash: hashDiff(key, '<write>', content), summary: `${base}: rewrote file (${lines} lines)`, noop: false };
  } else {
    const edits = toolName === 'MultiEdit' && Array.isArray(input.edits) && input.edits.length
      ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    const oldAll = edits.map((e) => (e && e.old_string) || '').join('\n<edit>\n');
    const newAll = edits.map((e) => (e && e.new_string) || '').join('\n<edit>\n');
    const first = edits[0] || {};
    const [o, n] = firstChangedLine(first.old_string, first.new_string);
    const more = edits.length > 1 ? ` (+${edits.length - 1} more)` : '';
    res = {
      file: key,
      diffHash: hashDiff(key, oldAll, newAll),
      summary: `${base}: ${code(o)} → ${code(n)}${more}`,
      noop: squash(oldAll) === squash(newAll), // whitespace-only / formatting
    };
  }
  const reportFile = cfg && cfg.reportFile ? cfg.reportFile.split(path.sep).join('/') : 'LOOP-REPORT.md';
  res.skip = !key || res.noop
    || /(^|\/)\.claude\/doom-loop-guard\//.test(key)
    || key === reportFile
    || /\.(md|mdx|txt|rst)$/i.test(key);     // prose edits rarely fix a failing command
  return res;
}

function push(state, entry, now) {
  state.timeline.push({ at: now, ...entry });
}

function hookOut(event, context, extra = {}) {
  return { ...extra, hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

// A warning for Claude, plus an audit event for the admin.
function warnResult(event, rule, text, extra = {}) {
  return { ...extra, output: hookOut(event, text), events: [{ kind: 'warn', rule }] };
}

// Two results from one hook call: a stop wins; otherwise both warnings are kept.
function mergeResults(a, b) {
  if (!a || !Object.keys(a).length) return b || {};
  if (!b || !Object.keys(b).length) return a;
  if (a.stop) return a;
  if (b.stop) return b;
  const ca = a.output && a.output.hookSpecificOutput && a.output.hookSpecificOutput.additionalContext;
  const cb = b.output && b.output.hookSpecificOutput && b.output.hookSpecificOutput.additionalContext;
  const out = { ...a, ...b, memoryChanged: Boolean(a.memoryChanged || b.memoryChanged), events: [...(a.events || []), ...(b.events || [])] };
  if (ca && cb) out.output = hookOut(b.output.hookSpecificOutput.hookEventName, `${ca}\n\n${cb}`);
  else out.output = b.output || a.output;
  return out;
}

// Key order must not matter: {a,b} and {b,a} are the same call.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const fmt = (n) => Math.round(n).toLocaleString('en-US');

function attemptsList(failure, max = 5) {
  const list = (failure && failure.attempts) || [];
  return list.slice(-max).map((a, i) => `${i + 1}) ${a.summary}`).join('; ');
}

// ---------- briefing for a new session ----------
function briefing(memory, cfg) {
  const items = Object.values(memory.failures || {})
    .filter((f) => f && !f.resolved && (f.count >= 2 || (f.attempts || []).length > 0))
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))
    .slice(0, cfg.maxBriefingItems);
  if (!items.length) return null;
  const head = `${TAG} Earlier sessions in this project hit failures that are still unresolved. `
    + 'Do not repeat fixes that already failed:\n';
  const tail = 'If you work on one of these, reproduce it first: it may already be fixed. '
    + 'Otherwise choose an approach that is not on this list.';
  let body = '';
  items.forEach((f, i) => {
    const what = f.command ? code(clip(f.command, 80)) : f.tool;
    let s = `${i + 1}. ${what} failed ${f.count} times (last ${day(f.lastAt)}) with: ${clip(f.excerpt, 160)}`;
    if ((f.attempts || []).length) s += `\n   Already tried, did not fix it on its own: ${clip(attemptsList(f, 4), 420)}`;
    if ((head + body + s + tail).length <= BRIEFING_MAX_CHARS) body += `${s}\n`;
  });
  return body ? head + body + tail : null;
}

function onSessionStart(input, ctx) {
  const { memory, cfg, state } = ctx;
  state.haltPending = null;                       // never carry a stop into a resumed session
  if (!cfg.briefing || input.source === 'resume') return {};
  const text = briefing(memory, cfg);
  return text ? { output: hookOut('SessionStart', text) } : {};
}

function onUserPrompt(input, ctx) {
  const p = clip(redact(input.prompt), 300);
  if (p && !p.startsWith('/')) ctx.state.goal = p;
  ctx.state.haltPending = null; // the user is steering again
  return {};
}

// ---------- before any tool: deliver a pending stop, or flag a repeated fix ----------
function onPreTool(input, ctx) {
  const { state } = ctx;
  // A loop was detected on a failure event. Claude Code ignores `continue:false`
  // on PostToolUseFailure, so the halt is delivered on the very next tool call.
  if (state.haltPending) {
    const reason = state.haltPending;
    state.haltPending = null;
    return {
      output: {
        continue: false, stopReason: reason, systemMessage: reason,
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      },
    };
  }
  const budget = checkBudget(input, ctx);
  if (budget && budget.stop) return budget;
  const same = checkSameCall(input, ctx);
  if (same && same.stop) return same;
  noteWriteTarget(input, ctx);
  return mergeResults(mergeResults(mergeResults(budget, same), generatedEdit(input, ctx)), onPreEdit(input, ctx));
}

// A stop decided before a tool runs: deny this call and end the turn.
function preStop(ctx, rule, why) {
  const r = stopResult(ctx, rule, why, null);
  r.output.hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.output.stopReason };
  return r;
}

// ---------- session budgets: tokens (from the transcript) and tool calls ----------
// A stop fires once per multiple of the limit, so a user who says "keep going"
// gets another full budget before the next stop.
function checkBudget(input, ctx) {
  const { state, cfg } = ctx;
  state.toolCalls = (state.toolCalls || 0) + 1;
  state.budgetTrips = state.budgetTrips || {};
  const metrics = [
    ['tokens', (state.usage && state.usage.tokens) || 0, 'tokens', 'token'],
    ['toolCalls', state.toolCalls, 'tool calls', 'tool-call'],
  ];
  let res = null;
  for (const [key, value, label, adj] of metrics) {
    const { warn, stop } = cfg.budget[key];
    const trips = state.budgetTrips[key] || 0;
    if (stop && value >= stop * (trips + 1)) {
      const limit = stop * (trips + 1);
      state.budgetTrips[key] = Math.floor(value / stop);
      const why = `the session ${adj} budget was reached (${fmt(value)} ${label}, limit ${fmt(limit)})`;
      if (cfg.mode === 'stop') return preStop(ctx, `budget-${key}`, why);
      res = mergeResults(res, warnResult('PreToolUse', `budget-${key}`, `${TAG} ${why[0].toUpperCase()}${why.slice(1)}. Wrap up: summarize what is done and what is left for the user.`));
    } else if (warn && value >= warn && !state.warned[`budget:${key}`] && (!stop || value < stop)) {
      state.warned[`budget:${key}`] = true;
      res = mergeResults(res, warnResult('PreToolUse', `budget-${key}`, `${TAG} This session has used ${fmt(value)} ${label} `
        + `(warning at ${fmt(warn)}${stop ? `, stop at ${fmt(stop)}` : ''}). If the work is not converging, stop and summarize for the user.`));
    }
  }
  return res;
}

// ---------- the exact same tool call, same input, in a row ----------
function checkSameCall(input, ctx) {
  const { state, cfg } = ctx;
  const { warn, stop } = cfg.sameCall;
  if (!warn && !stop) return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const name = String(input.tool_name || 'tool');
  if (SHELL_TOOLS.has(name) && isIgnoredCommand(normalizeCommand(ti.command), cfg)) { state.lastCall = null; return null; }
  const h = shortHash(`${name}\n${stable(ti)}`);
  const lc = state.lastCall && state.lastCall.hash === h ? state.lastCall : { hash: h, count: 0 };
  lc.count += 1;
  state.lastCall = lc;
  const n = lc.count;
  if (stop && n >= stop && cfg.mode === 'stop') {
    lc.count = 0;
    return preStop(ctx, 'same-call', `the same ${name} call with the same input ran ${n} times in a row`);
  }
  if (warn && (n === warn || (n > warn && (n - warn) % 5 === 0))) {
    return warnResult('PreToolUse', 'same-call', `${TAG} You have made the same ${name} call with the same input ${n} times in a row. `
      + 'Its result will not change. Do something different, or stop and tell the user what you are waiting for.');
  }
  return null;
}

// Remember whether a Write target already exists, in case the tool response
// does not say whether it created or replaced the file.
function noteWriteTarget(input, ctx) {
  if (input.tool_name !== 'Write' || typeof ctx.exists !== 'function') return;
  const f = input.tool_input && input.tool_input.file_path;
  if (!f) return;
  ctx.state.writeExisted = ctx.state.writeExisted || {};
  ctx.state.writeExisted[relPath(f, ctx.projectDir)] = Boolean(ctx.exists(path.resolve(ctx.projectDir || '.', f)));
}

// An edit to a file that a tool regenerates is lost on the next build, and the
// error it was meant to fix comes back. Warn once per file per session.
function generatedEdit(input, ctx) {
  const { state, cfg } = ctx;
  if (cfg.generatedFiles === 'off' || !EDIT_TOOLS.has(input.tool_name)) return null;
  const ti = input.tool_input || {};
  const file = relPath(ti.file_path || ti.notebook_path || '', ctx.projectDir);
  const g = toolchain.generatedFile(file);
  if (!g || state.warned[`gen:${file}`]) return null;
  state.warned[`gen:${file}`] = true;
  const base = file.split('/').pop();
  return warnResult('PreToolUse', 'generated-file', `${TAG} ${base} ${g.what}, so this edit will be overwritten and the problem will come back. ${g.fix}`);
}

function onPreEdit(input, ctx) {
  const { memory, state, cfg } = ctx;
  if (cfg.repeatFix === 'off' || !EDIT_TOOLS.has(input.tool_name)) return {};
  const d = describeEdit(input.tool_name, input.tool_input || {}, ctx.projectDir, cfg);
  if (d.skip) return {};
  for (const f of Object.values(memory.failures || {})) {
    if (!f || f.resolved) continue;
    const hit = (f.attempts || []).find((a) => a.diffHash === d.diffHash);
    if (!hit) continue;
    const why = `${TAG} This exact change (${d.summary}) was already tried on ${day(hit.at)} and the error came back: `
      + `${f.excerpt}. On its own it did not fix that error; it may still be part of the fix. `
      + 'Make sure you are also changing something else this time.';
    if (cfg.repeatFix === 'block' && !state.deniedDiffs[d.diffHash]) {
      state.deniedDiffs[d.diffHash] = true;
      push(state, { kind: 'blocked', file: d.file, summary: d.summary }, ctx.now);
      const reason = `${why} If you are sure it is still needed, make the same edit again and it will be allowed.`;
      return { output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } },
        events: [{ kind: 'block', rule: 'repeat-fix' }] };
    }
    const key = `repeat:${d.diffHash}`;
    if (state.warned[key]) return {};
    state.warned[key] = true;
    return warnResult('PreToolUse', 'repeat-fix', why);
  }
  return {};
}

// ---------- after an edit ----------
function onPostEdit(input, ctx) {
  if (!EDIT_TOOLS.has(input.tool_name)) return {};
  const churn = input.tool_name === 'Write' ? rewriteChurn(input, ctx) : null;
  if (churn && churn.stop) return churn;
  return mergeResults(churn, postEditThrash(input, ctx));
}

// ---------- the same existing file rewritten whole, again and again ----------
function rewriteChurn(input, ctx) {
  const { state, cfg } = ctx;
  const { warn, stop } = cfg.rewriteChurn;
  if (!warn && !stop) return null;
  const ti = input.tool_input || {};
  const file = relPath(ti.file_path || '', ctx.projectDir);
  const reportFile = (cfg.reportFile || 'LOOP-REPORT.md').split(path.sep).join('/');
  if (!file || /(^|\/)\.claude\/doom-loop-guard\//.test(file) || file === reportFile) return null;
  const r = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  state.writeExisted = state.writeExisted || {};
  const existed = r.type === 'update' || r.type === 'create' ? r.type === 'update' : state.writeExisted[file] === true;
  delete state.writeExisted[file];
  if (!existed) return null;
  state.rewrites = state.rewrites || {};
  const n = (state.rewrites[file] || 0) + 1;
  state.rewrites[file] = n;
  const base = file.split('/').pop();
  const lines = String(ti.content == null ? '' : ti.content).split('\n').length;
  push(state, { kind: 'rewrite', file, summary: `${base}: rewrote file (${lines} lines)` }, ctx.now);
  if (stop && n >= stop && cfg.mode === 'stop') {
    state.rewrites[file] = 0;
    return stopResult(ctx, 'rewrite-churn', `${base} was fully rewritten ${n} times in this session`, null);
  }
  if (warn && (n === warn || (n > warn && (n - warn) % 3 === 0))) {
    return warnResult('PostToolUse', 'rewrite-churn', `${TAG} You have rewritten ${base} with Write ${n} times this session `
      + `(${lines} lines in the latest version). Every rewrite sends the whole file again, which costs far more tokens than an edit. `
      + 'If you are changing a few lines, use Edit with just those lines.');
  }
  return null;
}

// ---------- edits while the same error keeps coming back ----------
function postEditThrash(input, ctx) {
  const { state, cfg, now } = ctx;
  const d = describeEdit(input.tool_name, input.tool_input || {}, ctx.projectDir, cfg);
  if (d.skip) return {};
  state.pendingEdits.push({ file: d.file, diffHash: d.diffHash, summary: d.summary, at: now });
  push(state, { kind: 'edit', file: d.file, summary: d.summary }, now);
  if (!state.lastErrorHash) return {};
  const n = (state.fileEdits[d.file] || 0) + 1;
  state.fileEdits[d.file] = n;
  const base = d.file.split('/').pop();
  const err = state.errors[state.lastErrorHash];
  const { warn, stop } = cfg.fileThrash;
  if (n >= stop && cfg.mode === 'stop') {
    state.fileEdits[d.file] = 0;
    return stopResult(ctx, 'file-thrash', `${base} was edited ${n} times while the same error kept coming back`, state.lastErrorHash);
  }
  if (n === warn || (n > warn && n >= stop && (n - stop) % 3 === 0)) {
    return warnResult('PostToolUse', 'file-thrash', `${TAG} You have edited ${base} ${n} times and the error has not changed${err ? ` (${err.excerpt})` : ''}. `
      + 'Stop editing this file and re-check your assumption about the root cause.');
  }
  return {};
}

// A passing command fixes a remembered failure when it is the same command, or
// a broader one that includes it (`npm test` passing covers `npm test -- auth`).
function covers(passed, failed) {
  if (!passed || !failed) return false;
  if (passed === failed) return true;
  return passed.split(' ').length >= 2 && failed.startsWith(`${passed} `);
}

// Agents often write `cmd; echo "EXIT:$?"`, which makes a failing command look
// successful to Claude Code (and to every hook). Recover the real exit code from
// the echoed value so the failure still counts.
function maskedExitCode(rawCommand, response) {
  if (!/\$\?|\$LASTEXITCODE|%ERRORLEVEL%/i.test(String(rawCommand || ''))) return 0;
  const r = response && typeof response === 'object' ? response : {};
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = [...out.matchAll(/\b(?:exit(?:[ _-]?code)?|status|rc|code|ret)\s*[:=]?\s*(\d{1,3})\b/gi)].pop();
  const n = m ? Number(m[1]) : 0;
  return n > 0 && n < 256 ? n : 0;
}

// ---------- after a successful Bash command: did a known failure get fixed? ----------
function onPostBash(input, ctx) {
  const { memory, state, now } = ctx;
  const raw = input.tool_input && input.tool_input.command;
  const masked = maskedExitCode(raw, input.tool_response) || toolchain.silentFailure(raw, input.tool_response);
  if (masked) {
    const r = input.tool_response || {};
    const shown = String(raw).replace(ECHO_STATUS, '');
    const out = `${r.stderr || ''}\n${r.stdout || ''}`.replace(/^.*\b(?:exit(?:[ _-]?code)?|status|rc|code|ret)\s*[:=]?\s*\d{1,3}\b.*$/gim, '');
    const res = onFailure({ ...input, hook_event_name: 'PostToolUseFailure', tool_input: { ...input.tool_input, command: shown },
      error: `Exit code ${masked}\n${out.trim()}` }, ctx);
    // on PostToolUse, continue:false works directly: no need to wait for the next call
    if (res.output && res.output.hookSpecificOutput) res.output.hookSpecificOutput.hookEventName = 'PostToolUse';
    if (res.stop) state.haltPending = null;
    return res;
  }
  const cmd = normalizeCommand(raw);
  if (!cmd) return {};
  let changed = false;
  for (const f of Object.values(memory.failures || {})) {
    if (f && !f.resolved && f.command && covers(cmd, f.command)) {
      f.resolved = true; f.resolvedAt = now; changed = true;
    }
  }
  for (const k of Object.keys(state.cmdFails || {})) if (covers(cmd, k)) delete state.cmdFails[k];
  for (const [h, e] of Object.entries(state.errors)) {
    if (e.command && covers(cmd, e.command) && e.count > 0) {
      e.count = 0;
      push(state, { kind: 'fixed', command: cmd }, now);
      if (state.lastErrorHash === h) { state.lastErrorHash = null; state.pendingEdits = []; state.fileEdits = {}; }
    }
  }
  return { memoryChanged: changed };
}

// What makes two failures "the same". Build failures (compilers, linkers, build
// systems, engines) are fingerprinted by their error diagnostics only, sorted,
// so parallel output order, progress lines and moved line numbers don't matter.
// Everything else: the cleaned error, plus the target for non-shell tools (two
// different missing files are not a loop), plus the command when the error says
// nothing beyond an exit code.
function failureFingerprint(tool, errText, { shell = tool === 'Bash', command = '', target = '', cfg = {} } = {}) {
  const sig = shell && cfg.fingerprint !== 'legacy' ? toolchain.signature(errText, command) : null;
  const context = shell ? (!sig && errorIsBare(errText) ? command : '') : target;
  const hash = sig ? shortHash(`${tool}\n${context}\n<diagnostics>\n${sig.key}`) : hashError(tool, errText, context);
  const excerpt = (sig && clip(sig.lines[0], 160)) || errorExcerpt(errText) || clip(normalize(errText), 160) || 'failed with no output';
  const detail = sig ? sig.lines.slice(0, 8).join('\n').slice(0, 700) : (errorDetail(errText) || excerpt);
  return { hash, excerpt, detail, diagnostics: Boolean(sig) };
}

// ---------- after a failure ----------
function onFailure(input, ctx) {
  const { memory, state, cfg, now } = ctx;
  if (input.is_interrupt) return {};
  const tool = String(input.tool_name || 'tool');
  const errText = typeof input.error === 'string' ? input.error : JSON.stringify(input.error == null ? '' : input.error);
  if (REJECTION.test(errText) || errText.includes(TAG)) return {};
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const shell = SHELL_TOOLS.has(tool);
  const command = shell ? normalizeCommand(ti.command) : '';
  if (command && isIgnoredCommand(command, cfg)) return {};

  const target = command || relPath(ti.file_path || ti.path || ti.notebook_path || '', ctx.projectDir) || clip(ti.url || ti.pattern || '', 200);
  const { hash: h, excerpt, detail } = failureFingerprint(tool, errText, { shell, command, target, cfg });
  // A long build that hit the shell timeout makes progress on every rerun.
  const timedOutBuild = shell && toolchain.isTimeout(errText) && toolchain.isBuildCommand(command);

  // session counters, with decay: a repeat long after the last one starts over
  const e = state.errors[h] || (state.errors[h] = { count: 0, firstAt: now, tool, command, excerpt });
  if (e.lastAt && minutesBetween(e.lastAt, now) > cfg.windowMinutes) e.count = 0;
  e.count += 1; e.lastAt = now; e.excerpt = excerpt; e.detail = detail;

  // memory: the failure itself, plus the edits that did not fix it
  const f = memory.failures[h] || (memory.failures[h] = {
    tool, command, excerpt, count: 0, firstAt: now, lastAt: now, sessions: [], attempts: [],
  });
  f.count = (f.count || 0) + 1; f.lastAt = now; f.excerpt = excerpt; f.detail = detail; f.resolved = false;
  if (command) f.command = command;
  f.sessions = Array.isArray(f.sessions) ? f.sessions : [];
  f.attempts = Array.isArray(f.attempts) ? f.attempts : [];
  if (!f.sessions.includes(state.sessionId)) f.sessions = [...f.sessions, state.sessionId].slice(-10);
  if (state.lastErrorHash === h) {
    for (const p of state.pendingEdits) {
      if (!f.attempts.some((a) => a.diffHash === p.diffHash)) {
        f.attempts.push({ diffHash: p.diffHash, summary: p.summary, file: p.file, at: p.at, session: state.sessionId });
      }
    }
    if (f.attempts.length > 20) f.attempts = f.attempts.slice(-20);
  } else {
    state.fileEdits = {};
  }
  state.pendingEdits = [];
  state.lastErrorHash = h;
  push(state, { kind: 'failure', tool, target: clip(target, 120), excerpt, hash: h, n: e.count }, now);

  // second counter: the same command failing in a row, whatever the error says,
  // so a renamed variable or a shuffled message cannot dodge the guard
  let cf = null;
  if (command) {
    cf = state.cmdFails[command] || (state.cmdFails[command] = { count: 0, lastAt: now, errors: [] });
    if (minutesBetween(cf.lastAt, now) > cfg.windowMinutes) { cf.count = 0; cf.errors = []; }
    cf.count += 1; cf.lastAt = now;
    if (!cf.errors.includes(h)) cf.errors = [...cf.errors, h].slice(-10);
  }

  const c = timedOutBuild ? 0 : e.count;
  if (timedOutBuild) e.count = 0;
  return withHints(ctx, decideFailure(ctx, { c, cf, f, h, e, command, excerpt }), errText, command);
}

function decideFailure(ctx, { c, cf, f, h, e, command, excerpt }) {
  const { cfg } = ctx;
  if (c && c >= cfg.sameError.stop && cfg.mode === 'stop') {
    e.count = 0;
    if (cf) { cf.count = 0; cf.errors = []; }
    return haltOnFailure(ctx, stopResult(ctx, 'same-error', `the same error came back ${c} times`, h));
  }
  if (cf && cf.count >= cfg.sameCommand.stop && cfg.mode === 'stop') {
    const n = cf.count; const kinds = cf.errors.length;
    cf.count = 0; cf.errors = [];
    return haltOnFailure(ctx, stopResult(ctx, 'same-command',
      `${code(clip(command, 80))} failed ${n} times in a row (${kinds} different error messages)`, h));
  }
  if (c && c >= cfg.sameError.warn) {
    const tried = attemptsList(f);
    const msg = `${TAG} This is the ${ordinal(c)} time this exact error came back: ${excerpt}. `
      + (tried ? `Changes already tried that did not fix it on their own: ${tried}. ` : 'Your last attempt did not change the outcome. ')
      + (c >= cfg.sameError.stop
        ? 'You are in a loop. Stop retrying; summarize what you tried and ask the user how to proceed.'
        : 'Before trying again, state a different hypothesis for the root cause.');
    return warnResult('PostToolUseFailure', 'same-error', msg, { memoryChanged: true });
  }
  if (cf && cf.count >= cfg.sameCommand.warn) {
    const msg = `${TAG} ${code(clip(command, 80))} has failed ${cf.count} times in a row`
      + (cf.errors.length > 1 ? ` with ${cf.errors.length} different error messages` : '')
      + '. If each run fails for a new reason you may be making progress; if the messages only look different, '
      + 'the real problem has not changed. Check which one this is before the next run.';
    return warnResult('PostToolUseFailure', 'same-command', msg, { memoryChanged: true });
  }
  return { memoryChanged: true };
}

// Known environment problems (a locked file, Live Coding, out of memory, a full
// disk) get one plain hint per session, from the first failure: no code change
// fixes them, so waiting for a repeat only wastes runs.
function withHints(ctx, res, errText, command) {
  const { state, cfg } = ctx;
  if (!cfg.hints || res.stop) return res;
  const fresh = toolchain.envHints(errText, command).filter((x) => !state.warned[`hint:${x.id}`]);
  if (!fresh.length) return res;
  for (const x of fresh) state.warned[`hint:${x.id}`] = true;
  const text = fresh.map((x) => `${TAG} ${x.text}`).join('\n\n');
  const hint = { ...warnResult('PostToolUseFailure', `hint-${fresh[0].id}`, text), events: fresh.map((x) => ({ kind: 'warn', rule: `hint-${x.id}` })) };
  return mergeResults(res, hint);
}

function haltOnFailure(ctx, r) {
  ctx.state.haltPending = r.output.stopReason;
  r.output.hookSpecificOutput = {
    hookEventName: 'PostToolUseFailure',
    additionalContext: `${TAG} Loop detected: ${r.stop.why}. Do not call any more tools. `
      + 'Tell the user what you tried and that the details are in the loop report, then stop.',
  };
  return { ...r, memoryChanged: true };
}

function stopResult(ctx, rule, why, hash) {
  const { state, cfg, now } = ctx;
  state.stops += 1;
  push(state, { kind: 'stop', rule, why }, now);
  const where = cfg.report ? ` What was tried is in ${ctx.reportPath || cfg.reportFile}.` : '';
  const reason = `doom-loop-guard stopped this session: ${why}.${where} Start a fresh session; it will be told what already failed.`;
  return {
    stop: { rule, why, hash },
    output: { continue: false, stopReason: reason, systemMessage: reason },
    events: [{ kind: 'stop', rule, why }],
  };
}

function handle(input, ctx) {
  switch (input.hook_event_name) {
    case 'SessionStart': return onSessionStart(input, ctx);
    case 'UserPromptSubmit': return onUserPrompt(input, ctx);
    case 'PreToolUse': return onPreTool(input, ctx);
    case 'PostToolUse':
      if (SHELL_TOOLS.has(input.tool_name)) return onPostBash(input, ctx);
      return onPostEdit(input, ctx);
    case 'PostToolUseFailure': return onFailure(input, ctx);
    default: return {};
  }
}

module.exports = {
  failureFingerprint, SHELL_TOOLS, maskedExitCode, handle, briefing, describeEdit, normalizeCommand, errorExcerpt, errorDetail, errorIsBare, relPath, covers, ordinal, TAG,
};
