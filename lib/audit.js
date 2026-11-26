'use strict';
// Local audit trail: one JSON line per warning, block or stop. Nothing is sent
// anywhere; admins ship the file with whatever log agent they already run.
const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./normalize');

const MAX_BYTES = 10 * 1024 * 1024;

let VERSION = null;
function version() {
  if (VERSION) return VERSION;
  try {
    VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || 'unknown';
  } catch { VERSION = 'unknown'; }
  return VERSION;
}

function appendAudit(file, records) {
  if (!file || !records.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`); // keep one old file
  } catch { /* no file yet */ }
  fs.appendFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

function buildRecords(events, { now, sid, agentId, projectDir, state, cfg }) {
  return (events || []).map((e) => ({
    ts: now,
    kind: e.kind,
    rule: e.rule,
    why: e.why ? redact(e.why).slice(0, 300) : undefined,
    session: sid,
    agent: agentId || undefined,
    project: projectDir,
    tokens: (state.usage && state.usage.tokens) || 0,
    toolCalls: state.toolCalls || 0,
    mode: cfg.mode,
    policy: cfg.policy || undefined,
    version: version(),
  }));
}

module.exports = { appendAudit, buildRecords, MAX_BYTES };
