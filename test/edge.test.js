'use strict';
// One test per edge case in docs/EDGE-CASES.md (ids in the test names).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('../scripts/guard');
const { normalize, redact } = require('../lib/normalize');
const { normalizeCommand, errorIsBare, covers, ordinal, describeEdit, briefing } = require('../lib/engine');
const { loadConfig } = require('../lib/config');
const store = require('../lib/store');

function setup(cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'at-edge-'));
  const project = path.join(root, 'proj');
  fs.mkdirSync(project);
  if (cfg) fs.writeFileSync(path.join(project, '.doom-loop-guard.json'), JSON.stringify(cfg));
  const env = { CLAUDE_PROJECT_DIR: project, DOOM_LOOP_GUARD_STATE_DIR: path.join(root, 'state'), HOME: path.join(root, 'home') };
  let t = Date.parse('2026-11-25T10:00:00Z');
  const at = (mins) => { t += (mins || 1) * 60000; return new Date(t).toISOString(); };
  const ev = (o, mins, session = 's1') => run({ session_id: session, cwd: project, ...o }, env, at(mins));
  return { root, project, env, ev };
}
const bash = (command, error) => ({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, error, is_interrupt: false });
const ok = (command) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: {} });
const edit = (file, o, n) => ({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: o, new_string: n } });
const pre = (tool, input) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input });
const start = (source = 'startup') => ({ hook_event_name: 'SessionStart', source });

// ---------- same-command counter (the rename dodge) ----------
test('E01 a fix that only renames the variable in the error is still caught by the same-command counter', () => {
  const { ev } = setup();
  ev(start());
  const outs = ['fooA', 'fooB', 'fooC', 'fooD', 'fooE', 'fooF'].map((name, i) => {
    if (i) ev(edit('/p/src/a.js', `${name}x`, name));
    return ev(bash('npm test', `Exit code 1\nReferenceError: ${name} is not defined`));
  });
  // every error text differs, so the same-error rule never fires
  assert.equal(outs[0], null); assert.equal(outs[1], null); assert.equal(outs[2], null);
  assert.match(outs[3].hookSpecificOutput.additionalContext, /`npm test` has failed 4 times in a row with 4 different error messages/);
  assert.match(outs[4].hookSpecificOutput.additionalContext, /5 times in a row/);
  assert.equal(outs[5].continue, false);
  assert.match(outs[5].stopReason, /`npm test` failed 6 times in a row \(6 different error messages\)/);
});

test('E02 same-command counter resets when the command passes, and per command', () => {
  const { ev } = setup();
  ev(start());
  for (let i = 0; i < 3; i++) ev(bash('npm test', `Exit code 1\nError ${'abcdefghij'[i]}x happened here`));
  ev(ok('npm test'));
  for (let i = 0; i < 3; i++) assert.equal(ev(bash('npm test', `Exit code 1\nError ${'klmnopqrst'[i]}y happened here`)), null);
  for (let i = 0; i < 3; i++) assert.equal(ev(bash('npm run lint', `Exit code 1\nLint ${'uvwxyzabcd'[i]}z problem found`)), null);
});

test('E03 fixing compile errors one by one (new error each run) warns but does not stop before 6', () => {
  const { ev } = setup();
  ev(start());
  let last;
  for (let i = 0; i < 5; i++) last = ev(bash('tsc', `Exit code 2\nsrc/f${i}.ts(1,1): error TS2304: Cannot find name 'n${i}'.`));
  assert.notEqual(last.continue, false);
  assert.match(last.hookSpecificOutput.additionalContext, /you may be making progress/);
});

// ---------- what counts as "the same error" ----------
test('E04 exit-code-only failures of different commands are not the same error', () => {
  const { ev } = setup();
  ev(start());
  assert.equal(ev(bash('./a.sh', 'Exit code 1')), null);
  assert.equal(ev(bash('./b.sh', 'Exit code 1')), null);
  assert.equal(ev(bash('./c.sh', 'Exit code 1')), null);
  assert.equal(errorIsBare('Exit code 1\n'), true);
  assert.equal(errorIsBare('Exit code 1\nModuleNotFoundError: x'), false);
});

test('E05 non-shell tools: different missing files are different errors, same file repeats are one', () => {
  const { ev } = setup();
  ev(start());
  const read = (f) => ({ hook_event_name: 'PostToolUseFailure', tool_name: 'Read', tool_input: { file_path: f }, error: 'File does not exist.' });
  assert.equal(ev(read('/p/src/a/index.js')), null);
  assert.equal(ev(read('/p/src/b/index.js')), null);
  assert.equal(ev(read('/p/src/c/index.js')), null);
  assert.match(ev(read('/p/src/a/index.js')).hookSpecificOutput.additionalContext, /2nd time/);
});

test('E06 user rejections and our own blocks never count as failures', () => {
  const { ev } = setup();
  ev(start());
  for (let i = 0; i < 4; i++) {
    assert.equal(ev(bash('rm -rf build', "The user doesn't want to proceed with this tool use.")), null);
    assert.equal(ev(bash('x', '[doom-loop-guard] This exact change was already tried')), null);
  }
});

test('E07 normal check commands (grep, test, which, curl localhost) are ignored', () => {
  const { ev } = setup();
  ev(start());
  for (const c of ['grep -r foo src', 'test -f dist/app.js', 'which pnpm', 'curl -s localhost:3000/health', 'sleep 2 && curl http://127.0.0.1:8080']) {
    for (let i = 0; i < 4; i++) assert.equal(ev(bash(c, 'Exit code 1\ncurl: (7) Failed to connect')), null, c);
  }
});

test('E08 ignore list is configurable and can drop the defaults', () => {
  const a = setup({ ignoreCommands: ['^make smoke'] });
  a.ev(start());
  for (let i = 0; i < 4; i++) assert.equal(a.ev(bash('make smoke', 'Exit code 2\nsmoke failed badly')), null);
  const b = setup({ useDefaultIgnore: false });
  b.ev(start());
  b.ev(bash('grep x y', 'Exit code 2\ngrep: y: No such file or directory'));
  assert.match(b.ev(bash('grep x y', 'Exit code 2\ngrep: y: No such file or directory')).hookSpecificOutput.additionalContext, /2nd time/);
});

test('E09 a repeat long after the last one starts the count again (30 min window)', () => {
  const { ev } = setup();
  ev(start());
  const f = bash('npm test', 'Exit code 1\nAssertionError: nope');
  ev(f); ev(f, 1);
  assert.equal(ev(f, 45), null);          // 45 minutes later: count restarts at 1
});

test('E10 command wrappers do not split one command into many', () => {
  assert.equal(normalizeCommand('cd /app && npm test 2>&1 | tail -50'), 'npm test');
  assert.equal(normalizeCommand("cd 'my dir'; npm   test | head -n 20"), 'npm test');
  assert.equal(normalizeCommand('npm test | cat'), 'npm test');
});

test('E11 a broader passing command resolves a narrower failure; unrelated ones do not', () => {
  assert.equal(covers('npm test', 'npm test -- auth'), true);
  assert.equal(covers('node', 'node x.js'), false);
  assert.equal(covers('npm test -- auth', 'npm test'), false);
  const { ev } = setup();
  ev(start());
  const f = bash('npm test -- auth', 'Exit code 1\nAssertionError: expected 1');
  ev(f); ev(f);
  ev(ok('npm test'), 1, 's1');
  assert.equal(ev(start(), 1, 's2'), null);
});

// ---------- edits and the diff fingerprint ----------
test('E12 same edit in two files with the same name is not the same fix', () => {
  const cfg = loadConfig(null, {});
  const a = describeEdit('Edit', { file_path: '/p/src/a/index.js', old_string: 'x', new_string: 'y' }, '/p', cfg);
  const b = describeEdit('Edit', { file_path: '/p/src/b/index.js', old_string: 'x', new_string: 'y' }, '/p', cfg);
  assert.notEqual(a.diffHash, b.diffHash);
  assert.equal(a.file, 'src/a/index.js');
});

test('E13 whitespace-only edits, docs edits and our own files are not counted as fix attempts', () => {
  const cfg = loadConfig(null, {});
  assert.equal(describeEdit('Edit', { file_path: '/p/a.js', old_string: 'a  =1', new_string: 'a =1' }, '/p', cfg).skip, true);
  assert.equal(describeEdit('Edit', { file_path: '/p/README.md', old_string: 'a', new_string: 'b' }, '/p', cfg).skip, true);
  assert.equal(describeEdit('Write', { file_path: '/p/LOOP-REPORT.md', content: 'x' }, '/p', cfg).skip, true);
  assert.equal(describeEdit('Write', { file_path: '/p/.claude/doom-loop-guard/memory.json', content: '{}' }, '/p', cfg).skip, true);
  assert.equal(describeEdit('Edit', { file_path: '/p/a.js', old_string: 'a', new_string: 'b' }, '/p', cfg).skip, false);
});

test('E14 MultiEdit and Write are fingerprinted; a repeated Write is recognised', () => {
  const { ev } = setup();
  ev(start());
  const f = bash('npm test', 'Exit code 1\nAssertionError: x');
  const w = { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/p/cfg.js', content: 'module.exports = 1\n' } };
  ev(f); ev(w); ev(f);
  ev(start(), 1, 's2');
  const out = ev(pre('Write', w.tool_input), 1, 's2');
  assert.match(out.hookSpecificOutput.additionalContext, /cfg\.js: rewrote file/);
  const m = describeEdit('MultiEdit', { file_path: '/p/a.js', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }, '/p', loadConfig(null, {}));
  assert.match(m.summary, /\(\+1 more\)/);
});

test('E15 the repeat-fix warning is shown once per change per session, not on every retry', () => {
  const { ev } = setup();
  ev(start());
  const f = bash('npm test', 'Exit code 1\nAssertionError: x');
  ev(f); ev(edit('/p/a.js', 'a', 'b')); ev(f);
  ev(start(), 1, 's2');
  assert.ok(ev(pre('Edit', { file_path: '/p/a.js', old_string: 'a', new_string: 'b' }), 1, 's2'));
  assert.equal(ev(pre('Edit', { file_path: '/p/a.js', old_string: 'a', new_string: 'b' }), 1, 's2'), null);
});

test('E16 edits before any failure are not attempts and do not count as thrash', () => {
  const { ev } = setup();
  ev(start());
  for (let i = 0; i < 8; i++) assert.equal(ev(edit('/p/a.js', `v${i}`, `v${i + 1}`)), null);
});

test('E17 file-thrash warning is not repeated on every edit in warn mode', () => {
  const { ev } = setup({ mode: 'warn' });
  ev(start());
  ev(bash('npm test', 'Exit code 1\nAssertionError: x'));
  const outs = [];
  for (let i = 1; i <= 9; i++) outs.push(ev(edit('/p/a.js', `v${i}`, `v${i + 1}`)));
  const warned = outs.map((o, i) => (o ? i + 1 : 0)).filter(Boolean);
  assert.deepEqual(warned, [5, 6, 9]);
});

// ---------- secrets and untrusted text ----------
test('E18 secrets are redacted from memory, briefing and report', () => {
  assert.equal(redact('key sk-ant-api03-abcdefghijklmnopqrstuv'), 'key <SECRET>');
  assert.match(normalize('Authorization: Bearer abcdefghijklmnop'), /Bearer <SECRET>/);
  assert.match(normalize('ghp_abcdefghijklmnopqrstuvwxyz0123'), /<SECRET>/);
  assert.match(normalize('AKIAABCDEFGHIJKLMNOP denied'), /<SECRET> denied/);
  const { ev, project } = setup();
  ev(start());
  const f = bash('API_KEY=sk-live-abcdefghijklmnopqrstu npm test', 'Exit code 1\nError: invalid token=abcd1234efgh5678');
  ev(f); ev(f); ev(f);
  const files = [path.join(project, '.claude/doom-loop-guard/memory.json'), path.join(project, 'LOOP-REPORT.md')];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('sk-live-abcdefghijklmnopqrstu'), file);
    assert.ok(!text.includes('abcd1234efgh5678'), file);
  }
});

test('E19 error text with backticks, pipes and control characters cannot break the report', () => {
  const { ev, project } = setup();
  ev(start());
  const f = bash('npm test', 'Exit code 1\nError: bad ```js\nfoo | bar\u0007\u001b]8;;http://x\u0007link\u001b]8;;\u0007');
  ev(f); ev(edit('/p/we|ird.js', 'a', 'b')); ev(f); ev(f);
  const r = fs.readFileSync(path.join(project, 'LOOP-REPORT.md'), 'utf8');
  assert.ok(r.includes('````'), 'uses a longer fence');
  assert.ok(!/[\u0007\u001b]/.test(r), 'no control characters');
  assert.ok(r.includes('we\\|ird.js'), 'pipes escaped in the table');
});

test('E20 huge error output is handled quickly and capped', () => {
  const { ev } = setup();
  ev(start());
  const big = `Exit code 1\n${'Error: line of noise 12345\n'.repeat(200000)}`;
  const t0 = Date.now();
  ev(bash('npm test', big));
  assert.ok(Date.now() - t0 < 3000);
});

// ---------- state, files and failure handling ----------
test('E21 corrupt memory file is kept aside, not silently overwritten', () => {
  const { ev, project } = setup();
  const dir = path.join(project, '.claude/doom-loop-guard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.json'), '<<<<<<< HEAD\n{}');
  ev(start());
  ev(bash('npm test', 'Exit code 1\nAssertionError: x'));
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('memory.json.corrupt-')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8')).version, 1);
});

test('E22 memory with wrong shapes (hand-edited) does not crash', () => {
  const { ev, project } = setup();
  const dir = path.join(project, '.claude/doom-loop-guard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ version: 1, failures: { x: null, y: { count: 'a', lastAt: 'never', attempts: 'no' } } }));
  ev(start());
  ev(bash('npm test', 'Exit code 1\nAssertionError: x'));
  ev(pre('Edit', { file_path: '/p/a.js', old_string: 'a', new_string: 'b' }));
});

test('E23 read-only project: the warning still reaches Claude', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const { ev, project } = setup();
  ev(start());
  fs.chmodSync(project, 0o500);
  try {
    const f = bash('npm test', 'Exit code 1\nAssertionError: x');
    ev(f);
    assert.match(ev(f).hookSpecificOutput.additionalContext, /2nd time/);
  } finally { fs.chmodSync(project, 0o700); }
});

test('E24 an existing LOOP-REPORT.md written by someone else is not overwritten', () => {
  const { ev, project } = setup();
  fs.writeFileSync(path.join(project, 'LOOP-REPORT.md'), '# My own notes\n');
  ev(start());
  const f = bash('npm test', 'Exit code 1\nAssertionError: x');
  ev(f); ev(f);
  const out = ev(f);
  assert.equal(fs.readFileSync(path.join(project, 'LOOP-REPORT.md'), 'utf8'), '# My own notes\n');
  assert.ok(fs.existsSync(path.join(project, '.claude/doom-loop-guard/LOOP-REPORT.md')));
  assert.match(out.stopReason, /\.claude\/doom-loop-guard\/LOOP-REPORT\.md/);
});

test('E25 missing session id, missing cwd, non-object input', () => {
  const { env, project } = setup();
  assert.equal(run(null, env), null);
  assert.equal(run([], env), null);
  const e = { ...env, CLAUDE_PROJECT_DIR: path.join(project, 'nope') };
  run({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'x' }, error: 'Exit code 1\nboom error here', cwd: project }, e);
  run({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: { weird: true } }, env);
});

test('E26 subagents keep their own counters', () => {
  const { ev } = setup();
  ev(start());
  const f = bash('npm test', 'Exit code 1\nAssertionError: x');
  ev(f);
  assert.equal(ev({ ...f, agent_id: 'sub1' }), null);   // first time for the subagent
  assert.match(ev(f).hookSpecificOutput.additionalContext, /2nd time/);
});

test('E27 resuming a stopped session does not halt the first tool call', () => {
  const { ev } = setup();
  ev(start());
  const f = bash('npm test', 'Exit code 1\nAssertionError: x');
  ev(f); ev(f); ev(f);
  ev(start('resume'));
  assert.equal(ev(pre('Bash', { command: 'ls' })), null);
});

test('E28 /clear starts a fresh session; compact keeps counters and re-briefs', () => {
  const { ev } = setup();
  ev(start());
  const f = bash('npm test', 'Exit code 1\nAssertionError: x');
  ev(f); ev(edit('/p/a.js', 'a', 'b')); ev(f);
  const c = ev(start('compact'));
  assert.match(c.hookSpecificOutput.additionalContext, /Earlier sessions/);
  assert.equal(ev(f).continue, false);                  // count kept through compact
  ev(start('clear'));
  assert.equal(ev(f), null);                            // fresh after /clear
});

test('E29 briefing stays short with many failures', () => {
  const failures = {};
  for (let i = 0; i < 40; i++) {
    failures[`h${i}`] = { tool: 'Bash', command: `cmd${i} ${'x'.repeat(200)}`, excerpt: 'E'.repeat(300), count: 3, lastAt: '2026-11-25T10:00:00Z',
      attempts: Array.from({ length: 20 }, (_, j) => ({ summary: `f.js: ${'y'.repeat(100)}${j}`, diffHash: `d${j}` })) };
  }
  const b = briefing({ failures }, loadConfig(null, {}));
  assert.ok(b.length <= 2400, `briefing is ${b.length} chars`);
});

test('E30 memory is pruned: resolved, expired, and over 50 entries', () => {
  const now = Date.parse('2026-11-25T00:00:00Z');
  const m = { failures: { old: { lastAt: '2026-10-01T00:00:00Z' }, done: { lastAt: '2026-11-24T00:00:00Z', resolved: true } } };
  for (let i = 0; i < 60; i++) m.failures[`k${i}`] = { lastAt: new Date(now - i * 60000).toISOString() };
  store.pruneMemory(m, 14, now);
  assert.equal(Object.keys(m.failures).length, 50);
  assert.ok(!m.failures.old && !m.failures.done && m.failures.k0 && !m.failures.k59);
});

test('E31 parallel hook processes do not lose updates', async () => {
  const { env, project } = setup();
  const script = path.join(__dirname, '..', 'scripts', 'guard.js');
  const one = (i) => new Promise((resolve) => {
    const p = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
    p.on('close', resolve);
    p.stdin.end(JSON.stringify({ session_id: 'par', cwd: project, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
      tool_input: { command: `cmd${i}` }, error: `Exit code 1\nError: distinct failure number ${'abcdefghijkl'[i]}` }));
  });
  await Promise.all(Array.from({ length: 8 }, (_, i) => one(i)));
  const mem = JSON.parse(fs.readFileSync(path.join(project, '.claude/doom-loop-guard/memory.json'), 'utf8'));
  assert.equal(Object.keys(mem.failures).length, 8);
});

test('E32 config: bad values, unknown keys and a user-level file', () => {
  const { root, project } = setup();
  fs.mkdirSync(path.join(root, 'home', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home', '.claude', 'doom-loop-guard.json'), JSON.stringify({ mode: 'warn', sameError: { stop: 4 } }));
  fs.writeFileSync(path.join(project, '.doom-loop-guard.json'), JSON.stringify({ sameError: { warn: -1 }, reportFile: '../../etc/x', ignoreCommands: ['(', 5], wat: 1 }));
  const c = loadConfig(project, { HOME: path.join(root, 'home') });
  assert.equal(c.mode, 'warn');
  assert.deepEqual(c.sameError, { warn: 2, stop: 4 });
  assert.equal(c.reportFile, 'LOOP-REPORT.md');
  assert.equal(loadConfig(project, { HOME: path.join(root, 'home'), DOOM_LOOP_GUARD: ' OFF ' }).off, true);
});

test('E33 ordinals read correctly', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
});

test('E34 a failure hidden behind `; echo "EXIT:$?"` still counts (verified live: agents do this)', () => {
  const { maskedExitCode } = require('../lib/engine');
  assert.equal(maskedExitCode('node t.js; echo "EXIT:$?"', { stdout: 'EXIT:1\n', stderr: 'Error: boom' }), 1);
  assert.equal(maskedExitCode('node t.js; echo "exit code: $?"', { stdout: 'ok\nexit code: 0' }), 0);
  assert.equal(maskedExitCode('node t.js', { stdout: 'EXIT:1' }), 0);       // no $? in the command: trust it
  const { ev } = setup();
  ev(start());
  const masked = (n) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: `node test.js; echo "EXIT${n}:$?"`.replace(/EXIT\d/, 'EXIT') },
    tool_response: { stdout: 'EXIT:1\n', stderr: 'Error: add() check failed for the payments ledger\n' } });
  assert.equal(ev(masked(1)), null);
  ev(edit('/p/add.js', 'a - b', 'a + b'));
  const w = ev(masked(2));
  assert.equal(w.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(w.hookSpecificOutput.additionalContext, /2nd time.*add\(\) check failed.*add\.js: `a - b` → `a \+ b`/);
  const s = ev(masked(3));
  assert.equal(s.continue, false);
  assert.equal(ev(pre('Bash', { command: 'ls' })), null);   // stopped directly, nothing left pending
  // and the plain command is what memory records
  const b = ev(start(), 1, 's2');
  assert.match(b.hookSpecificOutput.additionalContext, /`node test\.js` failed 3 times/);
});

test('E35 a masked command that really passed (EXIT:0) resolves the failure', () => {
  const { ev } = setup();
  ev(start());
  const f = bash('node test.js', 'Exit code 1\nError: add() check failed');
  ev(f); ev(f);
  ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'node test.js; echo "EXIT:$?"' }, tool_response: { stdout: 'ok\nEXIT:0\n' } });
  assert.equal(ev(start(), 1, 's2'), null);
});

test('E36 normalizeCommand drops an echoed exit status', () => {
  assert.equal(normalizeCommand('node test.js; echo "EXIT:$?"'), 'node test.js');
  assert.equal(normalizeCommand('npm test 2>&1 | tail -5; echo exit=$?'), 'npm test');
});
