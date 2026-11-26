'use strict';
// Turns a raw tool error into a stable fingerprint: strips noise that changes
// between runs (timestamps, line numbers, paths, addresses, durations) but keeps
// the message, exit code and assertion values that say what actually failed.
const crypto = require('node:crypto');

// Secrets must never land in memory.json or a report someone screenshots.
const SECRETS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,                    // OpenAI/Anthropic/Stripe style keys
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                         // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                                   // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g,          // long base64 blobs
];

function redact(text) {
  let s = String(text == null ? '' : text);
  for (const re of SECRETS) s = s.replace(re, '<SECRET>');
  // "password: hunter2xyz", "Bearer abc...", "api_key=..." keep the label, hide the value
  s = s.replace(/\b(Bearer|Basic|token|api[_-]?key|password|passwd|secret)(\s*[:=]\s*|\s+)["']?[^\s"']{8,}/gi,
    (m, label, sep) => `${label}${sep}<SECRET>`);
  return s;
}

const RULES = [
  [/\x1b\[[0-9;?]*[A-Za-z]/g, ''],                                         // ANSI colours
  [/\x1b\][^\x07]*\x07/g, ''],                                             // OSC sequences (links, titles)
  [/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''],                                // other control chars
  [/\r\n?/g, '\n'],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>'],
  [/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<TS>'],                         // clock times
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>'],
  [/\b0x[0-9a-f]+\b/gi, '<HEX>'],
  [/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<HEX>'],       // hashes, shas
  // absolute / home / drive paths -> basename
  [/(?<![\w.])(?:~|[A-Za-z]:)?(?:[\\/][^\s\\/:'"`()[\]{}<>,;]+)+[\\/]?/g, (p) => {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : p;
  }],
  [/\b\d+(?:\.\d+)?\s?(?:ms|msec|s|sec|secs|seconds|m|min|mins|minutes)\b/gi, '<DUR>'],
  [/:\d+(?::\d+)?\b/g, ':<N>'],                                               // :line:col
  [/\b(line|ln|col|column)\s+\d+/gi, '$1 <N>'],
  [/[ \t]+/g, ' '],
  [/\n\s*\n+/g, '\n'],
];

function normalize(text) {
  let s = String(text == null ? '' : text);
  if (s.length > 50000) s = s.slice(0, 50000);
  s = redact(s);
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s.trim();
}

function shortHash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

// `context` is mixed in when the error alone is not specific enough (see engine).
function hashError(toolName, errorText, context = '') {
  return shortHash(`${toolName || ''}\n${context}\n${normalize(errorText)}`);
}

// Fingerprint of a code change, so the same fix can be recognised when it is
// re-applied (in this session or a later one). Whitespace-insensitive.
// `fileKey` should be the project-relative path, so two index.js files in
// different folders never collide and a shared memory file works on any machine.
const squash = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
function hashDiff(fileKey, oldText, newText) {
  const key = String(fileKey || '').replace(/\\/g, '/');
  return shortHash(`${key}\n${squash(oldText)}\n---\n${squash(newText)}`);
}

module.exports = { normalize, hashError, hashDiff, shortHash, redact, squash };

