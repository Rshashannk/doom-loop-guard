'use strict';
// Token usage for a session, read from Claude Code's transcript (hooks get no
// usage data). The transcript is JSONL. Each assistant message is written once
// per content block, every copy carrying the same message id and usage, so we
// count each id once. Reads are incremental: only bytes after the last offset,
// and only up to the last complete line. The format is not a public contract,
// so any surprise disables the count for that line, never the hook.
const fs = require('node:fs');

const CHUNK = 8 * 1024 * 1024; // most we read in one hook call; the rest waits for the next
const SEEN_MAX = 64;

const fresh = (file) => ({ path: String(file || ''), offset: 0, head: '', tokens: 0, cacheRead: 0, output: 0, messages: 0, seen: [] });
const HEAD = 128; // the first bytes identify the file: a rewrite of the same size still starts over
const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

function readUsage(file, prev) {
  let tx = prev && prev.path === String(file) && Number.isFinite(prev.offset) ? { ...prev, seen: [...(prev.seen || [])] } : fresh(file);
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const hb = Buffer.alloc(Math.min(HEAD, size));
    const head = hb.subarray(0, fs.readSync(fd, hb, 0, hb.length, 0)).toString('latin1');
    // rewritten or truncated: start over
    if (size < tx.offset || (tx.offset > 0 && tx.head !== head.slice(0, tx.head.length))) tx = fresh(file);
    if (!tx.head || tx.head.length < HEAD) tx.head = head;
    if (size === tx.offset) return tx;
    const len = Math.min(size - tx.offset, CHUNK);
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, tx.offset);
    const text = buf.subarray(0, got).toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) {
      // one huge line bigger than a chunk: skip it rather than stall forever
      if (got === CHUNK) tx.offset += got;
      return tx;
    }
    tx.offset += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
    for (const line of text.slice(0, end).split('\n')) {
      if (!line.includes('"usage"')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const m = e && e.type === 'assistant' && e.message;
      const usage = m && m.usage;
      if (!usage || typeof usage !== 'object') continue;
      const id = typeof m.id === 'string' ? m.id : '';
      if (id && tx.seen.includes(id)) continue;
      if (id) { tx.seen.push(id); if (tx.seen.length > SEEN_MAX) tx.seen.shift(); }
      const out = n(usage.output_tokens);
      tx.tokens += n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + out;
      tx.cacheRead += n(usage.cache_read_input_tokens);
      tx.output += out;
      tx.messages += 1;
    }
    return tx;
  } catch {
    return tx;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

module.exports = { readUsage };
