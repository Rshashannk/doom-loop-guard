'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Commands whose non-zero exit is normal (a check, a search, a wait) and should
// never count as a loop. Claude Code already treats grep/diff "no match" as
// success, but wrappers and other tools still exit 1.
const DEFAULT_IGNORE = [
  '^(grep|egrep|fgrep|rg|ag|git grep)\\b',
  '^(test|\\[|\\[\\[)\\s',
  '^(which|command -v|type|hash)\\b',
  '^(pgrep|pidof|lsof)\\b',
  '^(diff|cmp|git diff)\\b',
  '^(sleep|wait)\\b',
  '^(curl|wget|nc)\\b.*(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0)',
];

const DEFAULTS = Object.freeze({
  mode: 'stop',              // 'stop' halts on a loop; 'warn' never halts
  sameError: { warn: 2, stop: 3 },
  fileThrash: { warn: 5, stop: 6 },
  sameCommand: { warn: 4, stop: 6 }, // same command failing in a row, whatever the error says
  windowMinutes: 30,         // a repeat only counts if the last one was this recent
  repeatFix: 'warn',         // 'warn' tells Claude before it re-applies a failed change; 'block' denies it once per session; 'off'
  briefing: true,            // tell a new session what already failed
  memoryDays: 14,            // forget failures older than this
  maxBriefingItems: 5,
  report: true,
  reportFile: 'LOOP-REPORT.md',
  ignoreCommands: DEFAULT_IGNORE,
});

const posInt = (v, d, max = 1000) => (Number.isInteger(v) && v >= 1 && v <= max ? v : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

function compile(list) {
  const out = [];
  for (const src of Array.isArray(list) ? list.slice(0, 100) : []) {
    if (typeof src !== 'string' || src.length > 300) continue;
    try { out.push(new RegExp(src, 'i')); } catch { /* skip a bad pattern */ }
  }
  return out;
}

function loadConfig(projectDir, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const user = (home && readJson(path.join(home, '.claude', 'doom-loop-guard.json'))) || {};
  const proj = (projectDir && readJson(path.join(projectDir, '.doom-loop-guard.json'))) || {};
  const raw = { ...user, ...proj };
  const se = { ...(user.sameError || {}), ...(proj.sameError || {}) };
  const ft = { ...(user.fileThrash || {}), ...(proj.fileThrash || {}) };
  const sc = { ...(user.sameCommand || {}), ...(proj.sameCommand || {}) };
  const extraIgnore = [...(Array.isArray(user.ignoreCommands) ? user.ignoreCommands : []),
    ...(Array.isArray(proj.ignoreCommands) ? proj.ignoreCommands : [])];
  const cfg = {
    mode: oneOf(raw.mode, ['stop', 'warn'], DEFAULTS.mode),
    sameError: { warn: posInt(se.warn, DEFAULTS.sameError.warn), stop: posInt(se.stop, DEFAULTS.sameError.stop) },
    fileThrash: { warn: posInt(ft.warn, DEFAULTS.fileThrash.warn), stop: posInt(ft.stop, DEFAULTS.fileThrash.stop) },
    sameCommand: { warn: posInt(sc.warn, DEFAULTS.sameCommand.warn), stop: posInt(sc.stop, DEFAULTS.sameCommand.stop) },
    windowMinutes: posInt(raw.windowMinutes, DEFAULTS.windowMinutes, 100000),
    repeatFix: oneOf(raw.repeatFix, ['block', 'warn', 'off'], DEFAULTS.repeatFix),
    briefing: bool(raw.briefing, DEFAULTS.briefing),
    memoryDays: posInt(raw.memoryDays, DEFAULTS.memoryDays, 3650),
    maxBriefingItems: posInt(raw.maxBriefingItems, DEFAULTS.maxBriefingItems, 20),
    report: bool(raw.report, DEFAULTS.report),
    reportFile: typeof raw.reportFile === 'string' && /^[\w.\- /]{1,200}$/.test(raw.reportFile)
      && !path.isAbsolute(raw.reportFile) && !raw.reportFile.split(/[\\/]/).includes('..')
      ? raw.reportFile : DEFAULTS.reportFile,
    ignore: compile(raw.useDefaultIgnore === false ? extraIgnore : [...DEFAULT_IGNORE, ...extraIgnore]),
    off: false,
  };
  const e = String(env.DOOM_LOOP_GUARD || '').trim().toLowerCase();
  if (['off', '0', 'false', 'no', 'disable', 'disabled'].includes(e)) cfg.off = true;
  if (e === 'warn') cfg.mode = 'warn';
  if (projectDir && fs.existsSync(path.join(projectDir, '.doom-loop-guard-off'))) cfg.off = true;
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, DEFAULT_IGNORE };
