'use strict';
// Renders LOOP-REPORT.md from what the hooks recorded. No model call.
const path = require('node:path');

const REPORT_HEADER = '# Loop report';
// A code fence longer than any backtick run inside the text, so error output
// containing ``` cannot break the report.
const fence = (text) => '`'.repeat(Math.max(3, ...(String(text).match(/`+/g) || ['']).map((m) => m.length + 1)));

const day = (iso) => String(iso || '').replace('T', ' ').slice(0, 16);
const mins = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));

function renderReport({ state, memory, stop, cfg, now }) {
  const f = (stop.hash && memory.failures[stop.hash]) || null;
  const e = (stop.hash && state.errors[stop.hash]) || null;
  const excerpt = (f && f.excerpt) || (e && e.excerpt) || 'unknown';
  const detail = (e && e.detail) || (f && f.detail) || excerpt;
  const command = (f && f.command) || (e && e.command) || '';
  const failures = state.timeline.filter((t) => t.kind === 'failure' && t.hash === stop.hash);
  const first = failures[0] ? failures[0].at : state.startedAt;
  const attempts = (f && f.attempts) || [];

  const fileCounts = {};
  for (const t of state.timeline) if (t.kind === 'edit' && t.file) fileCounts[t.file] = (fileCounts[t.file] || 0) + 1;
  const cell = (s) => String(s).replace(/\|/g, '\\|');

  const L = [];
  L.push(REPORT_HEADER, '');
  L.push(`Written by already-tried on ${day(now)} UTC. Session \`${state.sessionId}\`.`, '');
  L.push('## Why it stopped', '');
  L.push(`Rule **${stop.rule}**: ${stop.why}, over ${mins(first, now)} minutes.`, '');
  if (state.goal) L.push(`Task it was working on: "${state.goal}"`, '');
  L.push('## The error', '');
  if (command) L.push(`Command: \`${command}\``, '');
  { const fz = fence(detail); L.push(fz, detail, fz, ''); }
  L.push('## What was tried', '');
  let n = 0;
  for (const t of state.timeline) {
    if (t.kind === 'edit') L.push(`${++n}. Edited ${t.summary}`);
    else if (t.kind === 'failure') L.push(`${++n}. Ran ${t.target ? `\`${t.target}\`` : t.tool}: failed${t.hash === stop.hash ? ` (same error, #${t.n})` : `: ${t.excerpt}`}`);
    else if (t.kind === 'blocked') L.push(`${++n}. Blocked a repeat of an earlier failed change: ${t.summary}`);
    else if (t.kind === 'fixed') L.push(`${++n}. \`${t.command}\` passed`);
  }
  if (!n) L.push('Nothing recorded.');
  L.push('');
  if (attempts.length) {
    L.push('## Changes that did not fix this error on their own (all sessions)', '');
    attempts.slice(-10).forEach((a, i) => L.push(`${i + 1}. ${a.summary} (${day(a.at)})`));
    L.push('');
  }
  const files = Object.entries(fileCounts).sort((a, b) => b[1] - a[1]);
  if (files.length) {
    L.push('## Files touched', '', '| File | Edits |', '| --- | --- |');
    for (const [file, c] of files) L.push(`| ${cell(file)} | ${c} |`);
    L.push('');
  }
  L.push('## Paste this into a fresh session', '');
  const promptFence = fence(`${excerpt}${state.goal}${attempts.map((a) => a.summary).join('')}`);
  L.push(`${promptFence}text`);
  L.push('A previous session got stuck in a loop on this bug.');
  if (state.goal) L.push(`Goal: ${state.goal}`);
  L.push(`It kept failing with: ${excerpt}`);
  if (command) L.push(`Reproduce with: ${command}`);
  if (attempts.length) {
    L.push('These changes were already tried and did not fix it on their own. Do not retry them alone; one may still be part of the fix:');
    attempts.slice(-5).forEach((a, i) => L.push(`${i + 1}. ${a.summary}`));
  }
  L.push('Before editing anything: reproduce the failure once, list three different');
  L.push('hypotheses for the root cause that are not covered above, and explain which');
  L.push('one you will test first and why.');
  L.push(promptFence, '');
  L.push('_already-tried runs locally and sends nothing anywhere. Turn it off with `ALREADY_TRIED=off` or a `.already-tried-off` file._', '');
  return L.join('\n');
}

module.exports = { renderReport, REPORT_HEADER };
