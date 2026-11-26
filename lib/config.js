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
  // v0.2. A 0 means that level is off.
  rewriteChurn: { warn: 3, stop: 0 }, // full Write rewrites of the same existing file in a session
  sameCall: { warn: 5, stop: 10 },    // the exact same tool call, same input, in a row
  budget: { tokens: { warn: 0, stop: 0 }, toolCalls: { warn: 0, stop: 0 } }, // per session, off by default
  audit: true,                        // append warnings and stops to a local JSONL file
  // v0.3
  fingerprint: 'auto',                // 'auto' fingerprints build failures by their diagnostics; 'legacy' = v0.2 hashing
  hints: true,                        // one-time hints for environment problems (locked file, Live Coding, out of memory, disk full)
  generatedFiles: 'warn',             // warn before editing generated files (.generated.h, *.pb.go, node_modules); 'off'
});

// Admin policy files, next to Claude Code's own managed-settings.json.
const SYSTEM_POLICY_PATHS = {
  linux: ['/etc/claude-code/doom-loop-guard.json'],
  darwin: ['/Library/Application Support/ClaudeCode/doom-loop-guard.json'],
  win32: ['C:\\Program Files\\ClaudeCode\\doom-loop-guard.json'],
};
const systemPolicyPaths = () => SYSTEM_POLICY_PATHS[process.platform] || SYSTEM_POLICY_PATHS.linux;

const posInt = (v, d, max = 1000) => (Number.isInteger(v) && v >= 1 && v <= max ? v : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const level = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 1e12 ? v : d); // 0 = off
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const pair = (layers, key, sub, d) => {
  const m = Object.assign({}, ...layers.map((l) => obj(sub ? obj(obj(l)[key])[sub] : obj(l)[key])));
  return { warn: level(m.warn, d.warn), stop: level(m.stop, d.stop) };
};

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

// The policy file: the first system path that exists wins, even if it is broken
// (a broken admin file must not let an env var take over). The env path is only
// for machines with no system file, such as CI.
function findPolicy(env, systemPaths) {
  for (const p of systemPaths) {
    if (fs.existsSync(p)) return { file: p, value: readJson(p) || {} };
  }
  const p = env.DOOM_LOOP_GUARD_POLICY;
  if (p && path.isAbsolute(p) && fs.existsSync(p)) return { file: p, value: readJson(p) || {} };
  return { file: null, value: {} };
}

function loadConfig(projectDir, env = process.env, systemPaths = systemPolicyPaths()) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const user = (home && readJson(path.join(home, '.claude', 'doom-loop-guard.json'))) || {};
  const proj = (projectDir && readJson(path.join(projectDir, '.doom-loop-guard.json'))) || {};
  const policy = findPolicy(env, systemPaths);
  const pol = policy.value;
  const locked = pol.lock === true;
  const layers = [user, proj, pol];
  const raw = { ...user, ...proj, ...pol };
  if (locked) raw.mode = pol.mode; // with lock, only the policy picks the mode
  const se = pair(layers, 'sameError', null, DEFAULTS.sameError);
  const ft = pair(layers, 'fileThrash', null, DEFAULTS.fileThrash);
  const sc = pair(layers, 'sameCommand', null, DEFAULTS.sameCommand);
  const extraIgnore = layers.flatMap((l) => (Array.isArray(l.ignoreCommands) ? l.ignoreCommands : []));
  const defaultAudit = path.join(home || os.tmpdir(), '.claude', 'doom-loop-guard', 'audit.jsonl');
  const auditPick = [pol.auditFile, user.auditFile].find((v) => typeof v === 'string' && v.length < 500 && path.isAbsolute(v));
  const cfg = {
    mode: oneOf(raw.mode, ['stop', 'warn'], DEFAULTS.mode),
    // the v0.1 thresholds must stay at least 1
    sameError: { warn: se.warn || DEFAULTS.sameError.warn, stop: se.stop || DEFAULTS.sameError.stop },
    fileThrash: { warn: ft.warn || DEFAULTS.fileThrash.warn, stop: ft.stop || DEFAULTS.fileThrash.stop },
    sameCommand: { warn: sc.warn || DEFAULTS.sameCommand.warn, stop: sc.stop || DEFAULTS.sameCommand.stop },
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
    rewriteChurn: pair(layers, 'rewriteChurn', null, DEFAULTS.rewriteChurn),
    sameCall: pair(layers, 'sameCall', null, DEFAULTS.sameCall),
    budget: {
      tokens: pair(layers, 'budget', 'tokens', DEFAULTS.budget.tokens),
      toolCalls: pair(layers, 'budget', 'toolCalls', DEFAULTS.budget.toolCalls),
    },
    audit: locked ? bool(pol.audit, DEFAULTS.audit) : bool(raw.audit, DEFAULTS.audit), // a repo can't hide trips from a locked policy
    auditFile: auditPick || defaultAudit,
    fingerprint: oneOf(raw.fingerprint, ['auto', 'legacy'], DEFAULTS.fingerprint),
    hints: bool(raw.hints, DEFAULTS.hints),
    generatedFiles: oneOf(raw.generatedFiles, ['warn', 'off'], DEFAULTS.generatedFiles),
    policy: policy.file,
    locked,
    off: false,
  };
  if (!locked) {
    const e = String(env.DOOM_LOOP_GUARD || '').trim().toLowerCase();
    if (['off', '0', 'false', 'no', 'disable', 'disabled'].includes(e)) cfg.off = true;
    if (e === 'warn') cfg.mode = 'warn';
    if (projectDir && fs.existsSync(path.join(projectDir, '.doom-loop-guard-off'))) cfg.off = true;
  }
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, DEFAULT_IGNORE, systemPolicyPaths };
