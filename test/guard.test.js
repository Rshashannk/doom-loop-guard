'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../scripts/guard');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'at-test-'));
  const project = path.join(root, 'proj');
  fs.mkdirSync(project);
  const env = { CLAUDE_PROJECT_DIR: project, ALREADY_TRIED_STATE_DIR: path.join(root, 'state') };
  let t = Date.parse('2026-11-25T10:00:00Z');
  const tick = () => new Date((t += 60000)).toISOString();
  const ev = (session, o) => run({ session_id: session, cwd: project, ...o }, env, tick());
  return { root, project, env, ev };
}

const fail = (error = 'Exit code 1\nAssertionError: expected 200 got 500\n    at test/api.test.js:14:9 (12 ms)') => ({
  hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
  tool_input: { command: 'npm test 2>&1 | tail -20' }, error, is_interrupt: false,
});
const edit = (oldS, newS, file = '/x/proj/src/api.js') => ({
  hook_event_name: 'PostToolUse', tool_name: 'Edit',
  tool_input: { file_path: file, old_string: oldS, new_string: newS },
});
const preEdit = (oldS, newS, file = '/x/proj/src/api.js') => ({ ...edit(oldS, newS, file), hook_event_name: 'PreToolUse' });
const start = (source = 'startup') => ({ hook_event_name: 'SessionStart', source });

test('S1-S3: record at 1, warn at 2, stop and write report at 3', () => {
  const { ev, project } = setup();
  ev('s1', start());
  ev('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'fix the failing api test' });
  assert.equal(ev('s1', fail()), null);
  ev('s1', edit('return 500', 'return 200'));
  // same error, different line number and duration: still the same error
  const w = ev('s1', fail('Exit code 1\nAssertionError: expected 200 got 500\n    at test/api.test.js:15:3 (40 ms)'));
  assert.equal(w.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(w.hookSpecificOutput.additionalContext, /2nd time/);
  assert.match(w.hookSpecificOutput.additionalContext, /api\.js: `return 500` → `return 200`/);
  ev('s1', edit('status = 500', 'status = 200'));
  const s = ev('s1', fail());
  assert.equal(s.continue, false);
  assert.match(s.stopReason, /LOOP-REPORT\.md/);
  assert.match(s.hookSpecificOutput.additionalContext, /Loop detected.*Do not call any more tools/);
  // Claude Code ignores continue:false on PostToolUseFailure, so the next tool call is halted
  const h = ev('s1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(h.continue, false);
  assert.equal(h.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(ev('s1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
  const report = fs.readFileSync(path.join(project, 'LOOP-REPORT.md'), 'utf8');
  for (const part of ['## Why it stopped', 'same-error', 'expected 200 got 500', '## What was tried',
    'return 500', 'status = 500', '## Paste this into a fresh session', 'fix the failing api test', 'Reproduce with: npm test']) {
    assert.ok(report.includes(part), `report missing: ${part}`);
  }
});

test('a new fix that fails the same way still counts toward the loop', () => {
  const { ev } = setup();
  ev('s1', start());
  ev('s1', fail()); ev('s1', edit('a', 'b'));
  ev('s1', fail()); ev('s1', edit('c', 'd'));
  assert.equal(ev('s1', fail()).continue, false);
});

test('different errors do not add up', () => {
  const { ev } = setup();
  ev('s1', start());
  ev('s1', fail('Exit code 1\nTypeError: a is undefined'));
  ev('s1', fail('Exit code 1\nReferenceError: b is not defined'));
  assert.equal(ev('s1', fail('Exit code 1\nSyntaxError: Unexpected token')), null);
});

test('memory: a new session is briefed on what already failed', () => {
  const { ev } = setup();
  ev('s1', start());
  ev('s1', fail()); ev('s1', edit('return 500', 'return 200')); ev('s1', fail());
  const b = ev('s2', start());
  const text = b.hookSpecificOutput.additionalContext;
  assert.equal(b.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(text, /npm test/);
  assert.match(text, /expected 200 got 500/);
  assert.match(text, /Already tried, did not fix it on its own: 1\) api\.js: `return 500` → `return 200`/);
});

test('a single one-off failure is not worth a briefing', () => {
  const { ev } = setup();
  ev('s1', start()); ev('s1', fail());
  assert.equal(ev('s2', start()), null);
});

test('repeat fix (default warn): Claude is told before re-applying a failed change', () => {
  const { ev } = setup();
  ev('s1', start());
  ev('s1', fail()); ev('s1', edit('return 500', 'return 200')); ev('s1', fail());
  ev('s2', start());
  const w = ev('s2', preEdit('return 500', 'return 200'));
  assert.equal(w.hookSpecificOutput.permissionDecision, undefined);
  assert.match(w.hookSpecificOutput.additionalContext, /already tried.*may still be part of the fix/);
});

test('repeat fix (block): blocked once in a later session, allowed if Claude insists', () => {
  const { ev, project } = setup();
  fs.writeFileSync(path.join(project, '.already-tried.json'), JSON.stringify({ repeatFix: 'block' }));
  ev('s1', start());
  ev('s1', fail()); ev('s1', edit('return 500', 'return 200')); ev('s1', fail());
  ev('s2', start());
  const d = ev('s2', preEdit('return  500', 'return 200'));   // whitespace differs, same change
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /already tried.*make the same edit again/);
  const again = ev('s2', preEdit('return 500', 'return 200'));
  assert.equal(again.hookSpecificOutput.permissionDecision, undefined);
  assert.match(again.hookSpecificOutput.additionalContext, /already tried/);
  assert.equal(ev('s2', preEdit('return 500', 'return 201')), null);
});

test('a passing run of the same command marks the failure fixed', () => {
  const { ev } = setup();
  ev('s1', start());
  ev('s1', fail()); ev('s1', edit('a', 'b')); ev('s1', fail());
  ev('s1', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {} });
  assert.equal(ev('s2', start()), null);
  assert.equal(ev('s2', preEdit('a', 'b')), null);
});

test('S4: file thrash warns at 5 and stops at 6 edits while the error is unchanged', () => {
  const { ev } = setup();
  ev('s1', start());
  ev('s1', fail('Exit code 1\nonly once'));
  let out;
  for (let i = 1; i <= 4; i++) assert.equal(ev('s1', edit(`v${i}`, `v${i + 1}`)), null);
  out = ev('s1', edit('v5', 'v6'));
  assert.match(out.hookSpecificOutput.additionalContext, /edited api\.js 5 times/);
  out = ev('s1', edit('v6', 'v7'));
  assert.equal(out.continue, false);
  assert.match(out.stopReason, /edited 6 times/);
});

test('S6: off switch by env and by file; warn mode never stops', () => {
  const a = setup();
  a.env.ALREADY_TRIED = 'off';
  for (let i = 0; i < 4; i++) assert.equal(a.ev('s1', fail()), null);

  const b = setup();
  fs.writeFileSync(path.join(b.project, '.already-tried-off'), '');
  for (let i = 0; i < 4; i++) assert.equal(b.ev('s1', fail()), null);

  const c = setup();
  fs.writeFileSync(path.join(c.project, '.already-tried.json'), JSON.stringify({ mode: 'warn' }));
  c.ev('s1', start());
  for (let i = 0; i < 2; i++) c.ev('s1', fail());
  for (let i = 0; i < 3; i++) {
    const o = c.ev('s1', fail());
    assert.notEqual(o.continue, false);
    assert.match(o.hookSpecificOutput.additionalContext, /You are in a loop/);
  }
});

test('custom thresholds apply, bad config falls back to defaults', () => {
  const a = setup();
  fs.writeFileSync(path.join(a.project, '.already-tried.json'), JSON.stringify({ sameError: { warn: 3, stop: 5 } }));
  a.ev('s1', start());
  assert.equal(a.ev('s1', fail()), null);
  assert.equal(a.ev('s1', fail()), null);
  assert.match(a.ev('s1', fail()).hookSpecificOutput.additionalContext, /3rd time/);
  a.ev('s1', fail());
  assert.equal(a.ev('s1', fail()).continue, false);

  const b = setup();
  fs.writeFileSync(path.join(b.project, '.already-tried.json'), '{ not json');
  b.ev('s1', start());
  b.ev('s1', fail()); b.ev('s1', fail());
  assert.equal(b.ev('s1', fail()).continue, false);
});

test('a new user prompt cancels a pending halt', () => {
  const { ev } = setup();
  ev('s1', start());
  ev('s1', fail()); ev('s1', fail()); ev('s1', fail());
  ev('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'ok, try running it with the env var set' });
  assert.equal(ev('s1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } }), null);
});

test('interrupted calls are ignored', () => {
  const { ev } = setup();
  for (let i = 0; i < 4; i++) assert.equal(ev('s1', { ...fail(), is_interrupt: true }), null);
});

test('after a stop, resuming starts the count again', () => {
  const { ev } = setup();
  ev('s1', start());
  ev('s1', fail()); ev('s1', fail());
  assert.equal(ev('s1', fail()).continue, false);
  assert.equal(ev('s1', fail()), null);
});

test('the hook script never fails: bad stdin exits 0 with no output', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'guard.js')], {
    input: '{ broken', env: { ...process.env, ALREADY_TRIED_STATE_DIR: os.tmpdir() },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.toString(), '');
});

test('end to end through stdin with the recorded Claude Code payload', () => {
  const { root, project, env } = setup();
  const fx = { ...require('./fixtures/failure-node-throw.json'), cwd: project };
  let last;
  for (let i = 0; i < 3; i++) {
    last = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'guard.js')], {
      input: JSON.stringify(fx), env: { ...process.env, ...env },
    });
  }
  assert.equal(last.status, 0);
  assert.equal(JSON.parse(last.stdout.toString()).continue, false);
  assert.ok(fs.existsSync(path.join(project, 'LOOP-REPORT.md')));
  assert.ok(fs.existsSync(path.join(project, '.claude', 'already-tried', 'memory.json')));
  void root;
});
