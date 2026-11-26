#!/usr/bin/env node
'use strict';
// Entry point for every hook event. Reads the event JSON on stdin, prints a JSON
// decision on stdout, and always exits 0: a bug here must never break a session.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('../lib/config');
const store = require('../lib/store');
const { handle } = require('../lib/engine');
const { renderReport, REPORT_HEADER } = require('../lib/report');

function logError(env, err) {
  try {
    const dir = store.stateDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'errors.log'), `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`);
  } catch { /* give up quietly */ }
}

function projectDirOf(input, env) {
  for (const d of [env.CLAUDE_PROJECT_DIR, input.cwd]) {
    try { if (d && fs.statSync(d).isDirectory()) return path.resolve(d); } catch { /* try next */ }
  }
  return process.cwd();
}

// Subagents share the parent's session id; keep their counters separate.
function sessionKey(input) {
  let sid = input.session_id;
  if (!sid) {
    sid = input.transcript_path
      ? `t-${crypto.createHash('sha1').update(String(input.transcript_path)).digest('hex').slice(0, 16)}`
      : `ppid-${process.ppid}`;
  }
  return { sid: String(sid), key: input.agent_id ? `${sid}--${input.agent_id}` : String(sid) };
}

// Never overwrite a LOOP-REPORT.md that someone else wrote.
function reportTarget(projectDir, cfg) {
  const main = path.join(projectDir, cfg.reportFile);
  try {
    const head = fs.readFileSync(main, 'utf8').slice(0, 200);
    if (!head.startsWith(REPORT_HEADER)) return path.join(projectDir, '.claude', 'doom-loop-guard', 'LOOP-REPORT.md');
  } catch { /* does not exist yet: fine */ }
  return main;
}

function run(input, env = process.env, now = new Date().toISOString()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const projectDir = projectDirOf(input, env);
  const cfg = loadConfig(projectDir, env);
  if (cfg.off) return null;
  const { sid, key } = sessionKey(input);
  const isStart = input.hook_event_name === 'SessionStart';

  if (isStart && (input.source === 'startup' || input.source === 'clear' || !input.source)) {
    store.resetSession(key, env);
    store.pruneSessions(env);
  }

  const reportPath = reportTarget(projectDir, cfg);
  const memFile = store.memoryFile(projectDir);
  return store.withLock(store.sessionFile(key, env), () => store.withLock(memFile, () => {
    const state = store.loadSession(key, sid, env);
    const memory = store.loadMemory(projectDir);
    const res = handle(input, {
      state, memory, cfg, now, projectDir,
      reportPath: path.relative(projectDir, reportPath).split(path.sep).join('/'),
    }) || {};

    // each write is independent: a read-only repo must not swallow the warning
    if (res.stop && cfg.report) {
      try {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, renderReport({ state, memory, stop: res.stop, cfg, now }));
      } catch (err) { logError(env, err); }
    }
    if (res.memoryChanged || res.stop) {
      try { store.saveMemory(projectDir, memory, cfg.memoryDays); } catch (err) { logError(env, err); }
    }
    try { store.saveSession(key, state, env); } catch (err) { logError(env, err); }
    return res.output || null;
  }));
}

function main() {
  let data = '';
  const finish = () => {
    try {
      const out = run(JSON.parse(data || '{}'));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (err) {
      logError(process.env, err);
    }
    process.exitCode = 0;
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { if (data.length < 20e6) data += c; });
  process.stdin.on('end', finish);
  process.stdin.on('error', () => { process.exitCode = 0; });
}

if (require.main === module) main();
module.exports = { run, sessionKey, reportTarget };
void os;
