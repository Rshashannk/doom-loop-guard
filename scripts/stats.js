#!/usr/bin/env node
'use strict';
// Summarize the doom-loop-guard audit log.
// Usage: node scripts/stats.js [audit.jsonl ...] [--since 2026-11-01]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const si = args.indexOf('--since');
const since = si >= 0 ? Date.parse(args.splice(si, 2)[1]) : NaN;
const files = args.length ? args : [path.join(os.homedir(), '.claude', 'doom-loop-guard', 'audit.jsonl')];

const rows = [];
for (const f of files) {
  for (const name of [`${f}.1`, f]) {
    let text = '';
    try { text = fs.readFileSync(name, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.rule && (!Number.isFinite(since) || Date.parse(r.ts) >= since)) rows.push(r);
      } catch { /* skip a bad line */ }
    }
  }
}

if (!rows.length) {
  console.log(`No audit events found in ${files.join(', ')}.`);
  process.exit(0);
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const sessions = new Set(rows.map((r) => r.session));
const projects = new Set(rows.map((r) => r.project));
const ts = rows.map((r) => r.ts).filter(Boolean).sort();
console.log(`doom-loop-guard audit: ${plural(rows.length, 'event')}, ${plural(sessions.size, 'session')}, `
  + `${plural(projects.size, 'project')} (${String(ts[0]).slice(0, 10)} to ${String(ts[ts.length - 1]).slice(0, 10)})`);
console.log('');

const byRule = {};
for (const r of rows) {
  const b = byRule[r.rule] || (byRule[r.rule] = { stop: 0, warn: 0, block: 0, tokens: [] });
  b[r.kind] = (b[r.kind] || 0) + 1;
  if (r.kind === 'stop' && r.tokens) b.tokens.push(r.tokens);
}
const width = Math.max(...Object.keys(byRule).map((k) => k.length)) + 2;
for (const [rule, b] of Object.entries(byRule).sort((x, y) => y[1].stop - x[1].stop || y[1].warn - x[1].warn)) {
  const extra = b.block ? `, ${plural(b.block, 'block')}` : '';
  const tok = b.tokens.length ? `  (median tokens at stop: ${b.tokens.sort((x, y) => x - y)[Math.floor(b.tokens.length / 2)].toLocaleString('en-US')})` : '';
  console.log(`${rule.padEnd(width)}${plural(b.stop, 'stop')}, ${plural(b.warn, 'warning')}${extra}${tok}`);
}

const stopsByProject = {};
for (const r of rows) if (r.kind === 'stop') stopsByProject[r.project] = (stopsByProject[r.project] || 0) + 1;
const top = Object.entries(stopsByProject).sort((a, b) => b[1] - a[1]).slice(0, 5);
if (top.length) {
  console.log('\nMost stops by project:');
  for (const [p, n] of top) console.log(`  ${plural(n, 'stop').padEnd(10)} ${p}`);
}
