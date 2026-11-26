'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, hashError } = require('../lib/normalize');

test('strips timestamps', () => {
  assert.equal(
    normalize('2026-11-25T23:32:48.123Z ERROR boom'),
    normalize('2025-01-02 08:01:02 ERROR boom'),
  );
  assert.equal(normalize('at 12:00:01 boom'), normalize('at 09:15:59 boom'));
});

test('strips line and column numbers', () => {
  assert.equal(normalize('at foo (src/a.js:12:5)'), normalize('at foo (src/a.js:40:17)'));
  assert.equal(normalize('File "x.py", line 42, in f'), normalize('File "x.py", line 7, in f'));
});

test('reduces absolute and temp paths to the file name', () => {
  assert.equal(
    normalize('cannot open /tmp/tmp-81234/build/out.o'),
    normalize('cannot open /var/folders/zz/T/tmp-1/out.o'),
  );
  assert.equal(normalize('C:\\Users\\a\\proj\\x.ts failed'), normalize('D:\\work\\x.ts failed'));
});

test('strips hex addresses, uuids and long hashes', () => {
  assert.equal(normalize('segfault at 0x7ffd5e8c1a20'), normalize('segfault at 0x55d0c1'));
  assert.equal(
    normalize('request 3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90 failed'),
    normalize('request 11111111-2222-4333-8444-555555555555 failed'),
  );
  assert.equal(normalize('commit a1b2c3d4e5f6 broke it'), normalize('commit 0f9e8d7c6b5a broke it'));
});

test('strips durations and ANSI colour codes', () => {
  assert.equal(normalize('\x1b[31mFAIL\x1b[0m test (12 ms)'), normalize('FAIL test (1.4s)'));
});

test('keeps meaningful differences', () => {
  assert.notEqual(hashError('Bash', 'Exit code 1\nTypeError: x is undefined'),
    hashError('Bash', 'Exit code 1\nReferenceError: y is not defined'));
  assert.notEqual(hashError('Bash', 'Exit code 1'), hashError('Bash', 'Exit code 2'));
  assert.notEqual(hashError('Bash', 'expected 42 got 41'), hashError('Bash', 'expected 42 got 43'));
});

test('same error from the real recorded fixture hashes the same across runs', () => {
  const a = require('./fixtures/failure-node-throw.json');
  const b = JSON.parse(JSON.stringify(a));
  b.error = b.error.replace('12:00:01', '17:45:09').replace(':1:7', ':3:9').replace(':209:10', ':211:12');
  assert.equal(hashError(a.tool_name, a.error), hashError(b.tool_name, b.error));
});

test('hash is a short stable hex string', () => {
  const h = hashError('Bash', 'boom');
  assert.match(h, /^[0-9a-f]{12}$/);
  assert.equal(h, hashError('Bash', 'boom'));
});

const { hashDiff } = require('../lib/normalize');
test('diff hash ignores whitespace, not content or path', () => {
  assert.equal(hashDiff('src/x.js', 'if (a) {\n  b()\n}', 'if (a) { c() }'),
    hashDiff('src/x.js', 'if (a) { b() }', 'if (a) {\n c()\n}'));
  assert.notEqual(hashDiff('x.js', 'a', 'b'), hashDiff('x.js', 'b', 'a'));
  assert.notEqual(hashDiff('x.js', 'a', 'b'), hashDiff('y.js', 'a', 'b'));
});

const { errorExcerpt } = require('../lib/engine');
test('excerpt prefers the assertion or exception line over the FAIL banner', () => {
  assert.match(errorExcerpt('Exit code 1\nFAIL test/api.test.js\n  AssertionError: expected 200 got 500\n    at x.js:1:2'), /^AssertionError: expected 200 got 500$/);
  assert.match(errorExcerpt('Exit code 2\nmake: *** No rule to make target \'run\'. Stop.'), /No rule to make target/);
});
