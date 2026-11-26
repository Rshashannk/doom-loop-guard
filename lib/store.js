'use strict';
// Two small JSON stores:
//  - session state (temp dir, one file per session): counters for this session only
//  - project memory (<project>/.claude/already-tried/memory.json): failures that
//    outlive the session, so the next session can be told what already failed.
// Parallel tool calls run hooks at the same time, so every read-modify-write
// happens under a small lock file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { missing: true }; }
  try { return { value: JSON.parse(text) }; } catch { return { corrupt: true }; }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Runs fn while holding <file>.lock. Gives up waiting after ~1.5 s and treats a
// lock older than 10 s as stale (a crashed hook), so it can never hang a session.
function withLock(file, fn) {
  const lock = `${file}.lock`;
  let fd = null;
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }); } catch { /* reported by fn */ }
  for (let i = 0; i < 60 && fd === null; i++) {
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') break;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.unlinkSync(lock); continue; }
      } catch { continue; }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(lock); } catch { /* ignore */ }
    }
  }
}

function stateDir(env = process.env) {
  return env.ALREADY_TRIED_STATE_DIR || env.CLAUDE_PLUGIN_DATA
    || path.join(os.tmpdir(), 'already-tried');
}

const safeId = (id) => String(id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);

function sessionFile(key, env) {
  return path.join(stateDir(env), 'sessions', `${safeId(key)}.json`);
}

function newSession(sessionId) {
  return {
    version: 1,
    sessionId,
    startedAt: new Date().toISOString(),
    goal: '',
    errors: {},          // hash -> { count, firstAt, lastAt, excerpt, detail, tool, command }
    lastErrorHash: null,
    pendingEdits: [],    // edits since the last failure
    fileEdits: {},       // file -> edits since the error last changed
    deniedDiffs: {},     // diffHash -> true (blocked once this session)
    warned: {},          // key -> true
    timeline: [],        // capped list of what happened
    stops: 0,
    haltPending: null,
    cmdFails: {},        // command -> { count, lastAt, excerpts }
  };
}

function loadSession(key, sessionId, env) {
  const r = readJson(sessionFile(key, env));
  const s = r.value;
  if (s && s.version === 1 && s.errors && Array.isArray(s.timeline)) { s.cmdFails = s.cmdFails || {}; return s; }
  return newSession(sessionId);
}

function saveSession(key, state, env) {
  if (state.timeline.length > 60) state.timeline = state.timeline.slice(-60);
  if (state.pendingEdits.length > 30) state.pendingEdits = state.pendingEdits.slice(-30);
  const keys = Object.keys(state.errors);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete state.errors[k];
  writeJsonAtomic(sessionFile(key, env), state);
}

function resetSession(key, env) {
  try { fs.unlinkSync(sessionFile(key, env)); } catch { /* none */ }
}

// Session files live in the temp dir; drop ones untouched for a week.
function pruneSessions(env, now = Date.now()) {
  const dir = path.join(stateDir(env), 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const f = path.join(dir, n);
    try { if (now - fs.statSync(f).mtimeMs > 7 * 864e5) fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

function memoryFile(projectDir) {
  return path.join(projectDir, '.claude', 'already-tried', 'memory.json');
}

// The memory file may be hand-edited or merged by git: keep only well-formed entries.
function sanitizeMemory(m) {
  const out = { version: 1, failures: {} };
  for (const [h, f] of Object.entries(m.failures || {})) {
    if (!f || typeof f !== 'object' || !Number.isFinite(Date.parse(f.lastAt))) continue;
    const str = (v) => (typeof v === 'string' ? v : '');
    out.failures[h] = {
      ...f,
      tool: str(f.tool) || 'tool',
      command: str(f.command),
      excerpt: str(f.excerpt),
      detail: str(f.detail),
      count: Number.isInteger(f.count) && f.count > 0 ? f.count : 1,
      sessions: Array.isArray(f.sessions) ? f.sessions.filter((x) => typeof x === 'string') : [],
      attempts: Array.isArray(f.attempts)
        ? f.attempts.filter((a) => a && typeof a.diffHash === 'string' && typeof a.summary === 'string') : [],
      resolved: f.resolved === true,
    };
  }
  return out;
}

function loadMemory(projectDir) {
  const file = memoryFile(projectDir);
  const r = readJson(file);
  const m = r.value;
  if (m && m.version === 1 && m.failures && typeof m.failures === 'object' && !Array.isArray(m.failures)) return sanitizeMemory(m);
  if (r.corrupt) {
    // keep the broken file for the user instead of silently overwriting it
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
  }
  return { version: 1, failures: {} };
}

function pruneMemory(memory, days, now = Date.now()) {
  const cutoff = now - days * 864e5;
  for (const [h, f] of Object.entries(memory.failures)) {
    const last = Date.parse(f && f.lastAt);
    if (!f || f.resolved || !Number.isFinite(last) || last < cutoff) delete memory.failures[h];
  }
  const keys = Object.keys(memory.failures)
    .sort((a, b) => Date.parse(memory.failures[b].lastAt) - Date.parse(memory.failures[a].lastAt));
  for (const k of keys.slice(50)) delete memory.failures[k];
  return memory;
}

function saveMemory(projectDir, memory, days) {
  pruneMemory(memory, days);
  writeJsonAtomic(memoryFile(projectDir), memory);
}

module.exports = {
  loadSession, saveSession, resetSession, newSession, sessionFile, pruneSessions,
  loadMemory, saveMemory, pruneMemory, memoryFile, writeJsonAtomic, withLock, stateDir,
};
