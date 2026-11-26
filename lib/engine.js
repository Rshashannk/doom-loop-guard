'use strict';
// Pure decision logic. Each handler takes the hook input plus loaded state and
// returns { output, memoryChanged, stop }. No file or network access here.
const path = require('node:path');
const { normalize, hashError, hashDiff, squash, redact } = require('./normalize');

const TAG = '[doom-loop-guard]';
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
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
      .replace(/\s*\|\s*(?:cat|less|more)\s*$/, '')
      .replace(/\s*(?:;|&&|\|\|)\s*echo\b[^;&|]*\$\?[^;&|]*$/, '')   // `; echo "EXIT:$?"`
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
  return onPreEdit(input, ctx);
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
      return { output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } };
    }
    const key = `repeat:${d.diffHash}`;
    if (state.warned[key]) return {};
    state.warned[key] = true;
    return { output: hookOut('PreToolUse', why) };
  }
  return {};
}

// ---------- after an edit ----------
function onPostEdit(input, ctx) {
  const { state, cfg, now } = ctx;
  if (!EDIT_TOOLS.has(input.tool_name)) return {};
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
    return { output: hookOut('PostToolUse', `${TAG} You have edited ${base} ${n} times and the error has not changed${err ? ` (${err.excerpt})` : ''}. `
      + 'Stop editing this file and re-check your assumption about the root cause.') };
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
  if (!/\$\?/.test(String(rawCommand || ''))) return 0;
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
  const masked = maskedExitCode(raw, input.tool_response);
  if (masked) {
    const r = input.tool_response || {};
    const shown = String(raw).replace(/\s*(?:;|&&|\|\|)\s*echo\b[^;&|]*\$\?[^;&|]*$/, '');
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

// ---------- after a failure ----------
function onFailure(input, ctx) {
  const { memory, state, cfg, now } = ctx;
  if (input.is_interrupt) return {};
  const tool = String(input.tool_name || 'tool');
  const errText = typeof input.error === 'string' ? input.error : JSON.stringify(input.error == null ? '' : input.error);
  if (REJECTION.test(errText) || errText.includes(TAG)) return {};
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const command = tool === 'Bash' ? normalizeCommand(ti.command) : '';
  if (command && isIgnoredCommand(command, cfg)) return {};

  // What makes two failures "the same": the cleaned error, plus the target for
  // non-shell tools (two different missing files are not a loop), plus the
  // command when the error says nothing beyond an exit code.
  const target = command || relPath(ti.file_path || ti.path || ti.notebook_path || '', ctx.projectDir) || clip(ti.url || ti.pattern || '', 200);
  const context = tool === 'Bash' ? (errorIsBare(errText) ? command : '') : target;
  const h = hashError(tool, errText, context);
  const excerpt = errorExcerpt(errText) || clip(normalize(errText), 160) || 'failed with no output';
  const detail = errorDetail(errText) || excerpt;

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

  const c = e.count;
  if (c >= cfg.sameError.stop && cfg.mode === 'stop') {
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
  if (c >= cfg.sameError.warn) {
    const tried = attemptsList(f);
    const msg = `${TAG} This is the ${ordinal(c)} time this exact error came back: ${excerpt}. `
      + (tried ? `Changes already tried that did not fix it on their own: ${tried}. ` : 'Your last attempt did not change the outcome. ')
      + (c >= cfg.sameError.stop
        ? 'You are in a loop. Stop retrying; summarize what you tried and ask the user how to proceed.'
        : 'Before trying again, state a different hypothesis for the root cause.');
    return { output: hookOut('PostToolUseFailure', msg), memoryChanged: true };
  }
  if (cf && cf.count >= cfg.sameCommand.warn) {
    const msg = `${TAG} ${code(clip(command, 80))} has failed ${cf.count} times in a row`
      + (cf.errors.length > 1 ? ` with ${cf.errors.length} different error messages` : '')
      + '. If each run fails for a new reason you may be making progress; if the messages only look different, '
      + 'the real problem has not changed. Check which one this is before the next run.';
    return { output: hookOut('PostToolUseFailure', msg), memoryChanged: true };
  }
  return { memoryChanged: true };
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
  };
}

function handle(input, ctx) {
  switch (input.hook_event_name) {
    case 'SessionStart': return onSessionStart(input, ctx);
    case 'UserPromptSubmit': return onUserPrompt(input, ctx);
    case 'PreToolUse': return onPreTool(input, ctx);
    case 'PostToolUse':
      if (input.tool_name === 'Bash') return onPostBash(input, ctx);
      return onPostEdit(input, ctx);
    case 'PostToolUseFailure': return onFailure(input, ctx);
    default: return {};
  }
}

module.exports = {
  maskedExitCode, handle, briefing, describeEdit, normalizeCommand, errorExcerpt, errorDetail, errorIsBare, relPath, covers, ordinal, TAG,
};
