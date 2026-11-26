'use strict';
// v0.2: rewrite churn, identical calls, session budgets, managed policy, audit log.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run } = require('../scripts/guard');
const { readUsage } = require('../lib/budget');
const { loadConfig } = require('../lib/config');

function setup(cfg, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-v02-'));
  const project = path.join(root, 'proj');
  fs.mkdirSync(project);
  if (cfg) fs.writeFileSync(path.join(project, '.doom-loop-guard.json'), JSON.stringify(cfg));
  const home = path.join(root, 'home');
  const env = { CLAUDE_PROJECT_DIR: project, DOOM_LOOP_GUARD_STATE_DIR: path.join(root, 'state'), HOME: home, ...extraEnv };
  let t = Date.parse('2026-11-26T10:00:00Z');
  const at = (mins) => { t += (mins || 1) * 60000; return new Date(t).toISOString(); };
  const ev = (o, mins, session = 's1') => run({ session_id: session, cwd: project, ...o }, env, at(mins));
  const audit = () => {
    const f = path.join(home, '.claude', 'doom-loop-guard', 'audit.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse) : [];
  };
  return { root, project, env, ev, audit, home };
}
const pre = (tool, input, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...extra });
const write = (file, content, type) => ({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file, content },
  tool_response: type ? { type, filePath: file } : {} });
const ctx = (o) => (o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) || '';
const stopped = (o) => Boolean(o && o.continue === false);
const denied = (o) => Boolean(o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny');

function transcript(file, msgs) {
  const lines = [];
  for (const m of msgs) {
    // Claude Code writes one line per content block, all with the same message id and usage
    for (let i = 0; i < (m.blocks || 1); i++) {
      lines.push(JSON.stringify({ type: 'assistant', message: { id: m.id, role: 'assistant', usage: m.usage } }));
    }
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }));
  }
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}
const u = (inp, out, cw = 0, cr = 0) => ({ input_tokens: inp, output_tokens: out, cache_creation_input_tokens: cw, cache_read_input_tokens: cr });

// ---------- rewrite churn ----------
test('V01 the 3rd full rewrite of an existing file warns with file, count and lines', () => {
  const { ev, audit } = setup();
  const f = path.join('/p', 'src', 'game.js');
  const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(ctx(ev(write(f, body, 'update'))), '');
  assert.equal(ctx(ev(write(f, `${body}\nx`, 'update'))), '');
  const msg = ctx(ev(write(f, `${body}\ny`, 'update')));
  assert.match(msg, /rewritten game\.js with Write 3 times/);
  assert.match(msg, /401 lines/);
  assert.match(msg, /use Edit/i);
  assert.equal(audit().filter((a) => a.rule === 'rewrite-churn' && a.kind === 'warn').length, 1);
});

test('V02 creating new files never counts as churn, and a doc file still counts', () => {
  const { ev } = setup();
  for (let i = 0; i < 5; i++) assert.equal(ctx(ev(write(`/p/new${i}.js`, 'a', 'create'))), '');
  ev(write('/p/README.md', 'a', 'update')); ev(write('/p/README.md', 'b', 'update'));
  assert.match(ctx(ev(write('/p/README.md', 'c', 'update'))), /README\.md/);
});

test('V03 without tool_response.type, the PreToolUse existence check decides', () => {
  const { ev, project } = setup();
  const f = path.join(project, 'a.js');
  fs.writeFileSync(f, 'old');
  const g = path.join(project, 'brand-new.js');
  for (let i = 0; i < 2; i++) { ev(pre('Write', { file_path: f, content: `v${i}` })); ev(write(f, `v${i}`)); }
  ev(pre('Write', { file_path: f, content: 'v2' }));
  assert.match(ctx(ev(write(f, 'v2'))), /a\.js with Write 3 times/);
  for (let i = 0; i < 3; i++) { ev(pre('Write', { file_path: g, content: `v${i}` })); assert.equal(ctx(ev(write(g, `v${i}`))), ''); fs.rmSync(g, { force: true }); }
});

test('V04 rewriteChurn.stop stops the session; mode warn never stops', () => {
  const a = setup({ rewriteChurn: { warn: 2, stop: 4 } });
  const outs = [1, 2, 3, 4].map((i) => a.ev(write('/p/x.js', `v${i}`, 'update')));
  assert.match(ctx(outs[1]), /2 times/);
  assert.equal(stopped(outs[3]), true);
  assert.match(outs[3].stopReason, /x\.js was fully rewritten 4 times/);
  const b = setup({ mode: 'warn', rewriteChurn: { warn: 2, stop: 4 } });
  const outs2 = [1, 2, 3, 4, 5].map((i) => b.ev(write('/p/x.js', `v${i}`, 'update')));
  assert.equal(outs2.some(stopped), false);
});

// ---------- identical calls ----------
test('V05 the same tool call with the same input warns at 5 and stops at 10 in a row', () => {
  const { ev, audit } = setup();
  const outs = Array.from({ length: 10 }, () => ev(pre('Read', { file_path: '/p/a.js' })));
  assert.equal(outs.slice(0, 4).map(ctx).join(''), '');
  assert.match(ctx(outs[4]), /same Read call with the same input 5 times in a row/);
  assert.equal(stopped(outs[9]), true);
  assert.equal(denied(outs[9]), true);
  assert.ok(audit().some((a) => a.kind === 'stop' && a.rule === 'same-call'));
});

test('V06 a different call in between resets the identical-call count; key order does not matter', () => {
  const { ev } = setup();
  for (let i = 0; i < 20; i++) {
    const o = ev(pre('Bash', i % 2 ? { description: 'd', command: 'ls' } : { command: 'ls', description: 'd' }));
    if (i < 4) assert.equal(ctx(o), '');
    if (i === 4) assert.match(ctx(o), /5 times/); // reordered keys are still the same call
  }
  const b = setup();
  for (let i = 0; i < 30; i++) {
    const o = b.ev(pre('Bash', { command: i % 2 ? 'npm test' : 'cat a.js' }));
    assert.equal(stopped(o) || ctx(o) !== '', false);
  }
});

test('V07 ignored commands (polling with sleep) never count as identical calls', () => {
  const { ev } = setup();
  for (let i = 0; i < 15; i++) assert.equal(stopped(ev(pre('Bash', { command: 'sleep 30' }))), false);
});

// ---------- budgets ----------
test('V08 readUsage counts each message once, skips cache reads, and waits for a half-written line', () => {
  const { root } = setup();
  const tf = path.join(root, 't.jsonl');
  transcript(tf, [{ id: 'm1', blocks: 3, usage: u(10, 100, 1000, 50000) }, { id: 'm2', usage: u(5, 50, 0, 60000) }]);
  let tx = readUsage(tf, null);
  assert.equal(tx.tokens, 10 + 100 + 1000 + 5 + 50);
  assert.equal(tx.cacheRead, 110000);
  fs.appendFileSync(tf, JSON.stringify({ type: 'assistant', message: { id: 'm3', usage: u(1, 1) } }).slice(0, 30));
  tx = readUsage(tf, tx);
  assert.equal(tx.tokens, 1165);
  fs.appendFileSync(tf, `${JSON.stringify({ type: 'assistant', message: { id: 'm3', usage: u(1, 1) } }).slice(30)}\n`);
  tx = readUsage(tf, tx);
  assert.equal(tx.tokens, 1167);
  // garbage and a missing file never throw
  fs.appendFileSync(tf, 'not json\n{"type":"assistant","message":{"usage":"weird"}}\n');
  assert.equal(readUsage(tf, tx).tokens, 1167);
  assert.equal(readUsage(path.join(root, 'nope.jsonl'), null).tokens, 0);
});

test('V09 a new transcript path or a shrunk file starts the count over', () => {
  const { root } = setup();
  const a = path.join(root, 'a.jsonl'); const b = path.join(root, 'b.jsonl');
  transcript(a, [{ id: 'x', usage: u(100, 100) }]);
  transcript(b, [{ id: 'y', usage: u(1, 1) }]);
  let tx = readUsage(a, null);
  assert.equal(tx.tokens, 200);
  tx = readUsage(b, tx);
  assert.equal(tx.tokens, 2);
  fs.writeFileSync(b, '');
  transcript(b, [{ id: 'z', usage: u(3, 3) }]);
  assert.equal(readUsage(b, readUsage(b, tx)).tokens, 6);
});

test('V10 token budget warns once, stops at the limit, and after the user continues stops again at 2x', () => {
  const { ev, root, audit } = setup({ budget: { tokens: { warn: 1000, stop: 2000 } } });
  const tf = path.join(root, 'sess.jsonl');
  fs.writeFileSync(tf, '');
  const call = () => ev(pre('Bash', { command: `echo ${Math.random()}` }, { transcript_path: tf }));
  transcript(tf, [{ id: 'a', usage: u(0, 600) }]);
  assert.equal(ctx(call()), '');
  transcript(tf, [{ id: 'b', usage: u(0, 600) }]);
  const w = call();
  assert.match(ctx(w), /1,200 tokens/);
  assert.equal(ctx(call()), '');                       // warns once
  transcript(tf, [{ id: 'c', usage: u(0, 900) }]);
  const s = call();
  assert.equal(stopped(s), true);
  assert.equal(denied(s), true);
  assert.match(s.stopReason, /token budget/);
  ev({ hook_event_name: 'UserPromptSubmit', prompt: 'keep going' });
  assert.equal(stopped(call()), false);                // the user chose to continue
  transcript(tf, [{ id: 'd', usage: u(0, 1000) }]);
  assert.equal(stopped(call()), false);                // 3,100 < 2 x 2,000
  transcript(tf, [{ id: 'e', usage: u(0, 1000) }]);
  assert.equal(stopped(call()), true);                 // 4,100 >= 2 x 2,000
  const stops = audit().filter((a) => a.kind === 'stop' && a.rule === 'budget-tokens');
  assert.equal(stops.length, 2);
  assert.equal(stops[0].tokens, 2100);
});

test('V11 tool-call budget counts every tool call', () => {
  const { ev } = setup({ budget: { toolCalls: { warn: 3, stop: 5 } } });
  const outs = Array.from({ length: 5 }, (_, i) => ev(pre('Bash', { command: `echo ${i}` })));
  assert.match(ctx(outs[2]), /3 tool calls/);
  assert.equal(stopped(outs[4]), true);
});

test('V12 budgets are off by default and an unreadable transcript never breaks the hook', () => {
  const { ev, root } = setup();
  const tf = path.join(root, 'big.jsonl');
  transcript(tf, [{ id: 'a', usage: u(0, 9e9) }]);
  assert.equal(stopped(ev(pre('Bash', { command: 'ls' }, { transcript_path: tf }))), false);
  const b = setup({ budget: { tokens: { stop: 10 } } });
  assert.equal(stopped(b.ev(pre('Bash', { command: 'ls' }, { transcript_path: path.join(root, 'missing') }))), false);
  assert.equal(stopped(b.ev(pre('Bash', { command: 'ls' }, { transcript_path: root }))), false); // a directory
});

// ---------- policy ----------
test('V13 a managed policy wins over project config, and lock ignores every off switch', () => {
  const { root, project } = setup({ mode: 'warn', budget: { toolCalls: { stop: 999 } } });
  const pol = path.join(root, 'policy.json');
  fs.writeFileSync(pol, JSON.stringify({ lock: true, budget: { toolCalls: { stop: 3 } }, sameError: { stop: 4 } }));
  fs.writeFileSync(path.join(project, '.doom-loop-guard-off'), '');
  const env = { HOME: path.join(root, 'home'), DOOM_LOOP_GUARD_POLICY: pol, DOOM_LOOP_GUARD: 'off' };
  const cfg = loadConfig(project, env, []);
  assert.equal(cfg.off, false);
  assert.equal(cfg.mode, 'stop');
  assert.equal(cfg.budget.toolCalls.stop, 3);
  assert.equal(cfg.sameError.stop, 4);
  assert.equal(cfg.policy, pol);
});

test('V14 without lock, off switches still work; a system policy file beats the env path', () => {
  const { root, project } = setup();
  const pol = path.join(root, 'policy.json');
  fs.writeFileSync(pol, JSON.stringify({ budget: { tokens: { stop: 5 } } }));
  const sys = path.join(root, 'system.json');
  fs.writeFileSync(sys, JSON.stringify({ budget: { tokens: { stop: 7 } } }));
  const env = { HOME: path.join(root, 'home'), DOOM_LOOP_GUARD_POLICY: pol, DOOM_LOOP_GUARD: 'off' };
  assert.equal(loadConfig(project, env, []).off, true);
  assert.equal(loadConfig(project, env, [path.join(root, 'absent.json'), sys]).budget.tokens.stop, 7);
  // a broken policy file is ignored, never fatal
  fs.writeFileSync(sys, '{nope');
  assert.equal(loadConfig(project, { HOME: env.HOME }, [sys]).budget.tokens.stop, 0);
});

test('V15 project config cannot move the audit log; user and policy config can', () => {
  const { root, project } = setup({ auditFile: '/tmp/evil.jsonl' });
  const home = path.join(root, 'home');
  assert.equal(loadConfig(project, { HOME: home }, []).auditFile, path.join(home, '.claude', 'doom-loop-guard', 'audit.jsonl'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'doom-loop-guard.json'), JSON.stringify({ auditFile: path.join(root, 'mine.jsonl') }));
  assert.equal(loadConfig(project, { HOME: home }, []).auditFile, path.join(root, 'mine.jsonl'));
  // relative paths are rejected
  fs.writeFileSync(path.join(home, '.claude', 'doom-loop-guard.json'), JSON.stringify({ auditFile: 'rel.jsonl' }));
  assert.equal(loadConfig(project, { HOME: home }, []).auditFile, path.join(home, '.claude', 'doom-loop-guard', 'audit.jsonl'));
});

// ---------- audit ----------
test('V16 every v0.1 warning and stop also lands in the audit log, with no secrets', () => {
  const { ev, audit } = setup();
  const fail = (e) => ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: e });
  fail('Exit code 1\nError: token sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234 rejected');
  fail('Exit code 1\nError: token sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234 rejected');
  fail('Exit code 1\nError: token sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234 rejected');
  const a = audit();
  assert.deepEqual(a.map((x) => `${x.kind}:${x.rule}`), ['warn:same-error', 'stop:same-error']);
  for (const k of ['ts', 'session', 'project', 'version', 'why', 'toolCalls']) assert.ok(k in a[1], k);
  assert.doesNotMatch(JSON.stringify(a), /abcdefghijklmnop/);
});

test('V17 audit can be turned off, rotates at the size cap, and an unwritable path is not fatal', () => {
  const off = setup({ audit: false });
  for (let i = 0; i < 3; i++) off.ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'x' }, error: 'Exit code 1\nError: boom boom boom' });
  assert.equal(off.audit().length, 0);
  const { ev, home } = setup();
  const f = path.join(home, '.claude', 'doom-loop-guard', 'audit.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'x'.repeat(10 * 1024 * 1024 + 10));
  for (let i = 0; i < 2; i++) ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'x' }, error: 'Exit code 1\nError: boom boom boom' });
  assert.ok(fs.existsSync(`${f}.1`));
  assert.ok(fs.statSync(f).size < 10000);
  const bad = setup();
  fs.mkdirSync(path.join(bad.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(bad.home, '.claude', 'doom-loop-guard'), 'a file, not a dir');
  for (let i = 0; i < 2; i++) {
    const o = bad.ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'x' }, error: 'Exit code 1\nError: boom boom boom' });
    if (i === 1) assert.match(ctx(o), /2nd time/); // the warning still reaches Claude
  }
});

test('V18 stats.js summarizes the audit log by rule', () => {
  const { ev, home } = setup({ budget: { toolCalls: { stop: 2 } } });
  ev(pre('Bash', { command: 'a' })); ev(pre('Bash', { command: 'b' }));
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'stats.js'), path.join(home, '.claude', 'doom-loop-guard', 'audit.jsonl')], { encoding: 'utf8' });
  assert.match(out, /budget-toolCalls\s+1 stop/);
  assert.match(out, /1 session/);
});
