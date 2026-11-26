'use strict';
// v0.3: toolchain coverage. Real captured output (gcc, clang, make -j, ninja, Go,
// Rust, javac, tsc, jest, pytest) plus constructed Unreal / MSVC / Windows logs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hashError, normalize } = require('../lib/normalize');
const tc = require('../lib/toolchain');
const { failureFingerprint, handle, normalizeCommand, maskedExitCode } = require('../lib/engine');
const { DEFAULTS } = require('../lib/config');

const fx = (dir, name) => fs.readFileSync(path.join(__dirname, 'fixtures', dir, name), 'utf8');
const real = (n) => fx('toolchains', n);
const ue = (n) => fx('unreal', n);
const UE_BUILD = '"C:/Program Files/Epic Games/UE_5.4/Engine/Build/BatchFiles/Build.bat" ShooterGameEditor Win64 Development -Project="C:/Users/dev/Projects/ShooterGame/ShooterGame.uproject" -WaitMutex';
const UE_TESTS = '"C:/Program Files/Epic Games/UE_5.4/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" ShooterGame.uproject -ExecCmds="Automation RunTests ShooterGame; Quit" -unattended -nullrhi';
const fp = (text, command, cfg = {}) => failureFingerprint('Bash', text, { command, cfg });

// ---------- compatibility with v0.2 ----------

test('v0.2 fingerprints are unchanged for output that is not a build log', () => {
  const corpus = require('./fixtures/compat-v0.2.json');
  for (const c of corpus) {
    assert.equal(hashError(c.tool, c.error, c.context), c.hash, `changed: ${c.error.slice(0, 60)}`);
    if (c.tool === 'Bash') {
      assert.equal(tc.signature(c.error, c.context), null, `diagnostics mode on: ${c.error.slice(0, 60)}`);
      assert.equal(fp(c.error, c.context).hash, hashError(c.tool, c.error, c.context));
    }
  }
});

test('fingerprint: "legacy" turns the diagnostics fingerprint off', () => {
  const t = real('gcc-make.txt');
  assert.equal(fp(t, 'make -j4', { fingerprint: 'legacy' }).hash, hashError('Bash', t, ''));
  assert.equal(fp(t, 'make -j4', { fingerprint: 'legacy' }).diagnostics, false);
});

// ---------- real toolchains: the same error must fingerprint the same ----------

const SAME = [
  ['gcc + make -j4, lines moved', 'gcc-make.txt', 'gcc-make.shifted.txt', 'make -j4'],
  ['gcc + make -j4, parallel output reordered', 'gcc-make.txt', 'gcc-make.reordered.txt', 'make -j4'],
  ['clang + make -j4, lines moved', 'clang-make.txt', 'clang-make.shifted.txt', 'make -j4'],
  ['ninja, lines moved', 'ninja.txt', 'ninja.shifted.txt', 'ninja'],
  ['GNU ld, random temp object names', 'gcc-link.txt', 'gcc-link.shifted.txt', 'g++ c.cpp -o c'],
  ['cargo build, lines moved', 'cargo-build.txt', 'cargo-build.shifted.txt', 'cargo build'],
  ['go build, lines moved', 'go-build.txt', 'go-build.shifted.txt', 'go build ./...'],
  ['javac, lines moved', 'javac.txt', 'javac.shifted.txt', 'javac Foo.java'],
  ['tsc file(line,col), lines moved', 'tsc-pretty.txt', 'tsc-pretty.shifted.txt', 'tsc --noEmit'],
  ['jest code frame, lines moved, "estimated" time', 'jest.txt', 'jest.shifted.txt', 'npx jest'],
  ['pytest, lines moved', 'pytest.txt', 'pytest.shifted.txt', 'pytest'],
  ['ESLint stylish, lines moved', 'eslint.txt', 'eslint.shifted.txt', 'npx eslint src'],
  ['mypy, lines moved', 'mypy.txt', 'mypy.shifted.txt', 'python3 -m mypy m.py'],
  ['CMake + make -k -j8, 300 files, 36 errors in 4 libraries, two runs', 'make-big-k-1.txt', 'make-big-k-2.txt', 'cmake --build out -j8 -- -k'],
  ['CMake + ninja -k 0 -j8, 300 files, 36 errors, two runs', 'ninja-big-k-1.txt', 'ninja-big-k-2.txt', 'ninja -C out -k 0'],
  ['cargo clippy -D warnings (error without a code), lines moved', 'clippy.txt', 'clippy.shifted.txt', 'cargo clippy -- -D warnings'],
  ['cargo test, thread id changes every run', 'cargo-test-b.txt', 'cargo-test-b.rerun.txt', 'cargo test'],
];
for (const [name, a, b, cmd] of SAME) {
  test(`same error, same fingerprint: ${name}`, () => {
    assert.equal(fp(real(a), cmd).hash, fp(real(b), cmd).hash);
  });
}

test('ESLint shows the file and rule; the v0.2 hash missed the moved lines', () => {
  assert.equal(fp(real('eslint.txt'), 'npx eslint src').excerpt, "src/a/index.js: error: 'x' is assigned a value but never used (no-unused-vars)");
  assert.notEqual(fp(real('eslint.txt'), 'npx eslint src', { fingerprint: 'legacy' }).hash, fp(real('eslint.shifted.txt'), 'npx eslint src', { fingerprint: 'legacy' }).hash);
});

test('the big CMake build reports all 36 errors, each in its own library', () => {
  const d = tc.extractDiagnostics(real('make-big-k-1.txt'));
  assert.equal(d.lines.length, 36);
  assert.ok(d.lines.some((l) => l.startsWith('net/src/')) && d.lines.some((l) => l.startsWith('audio/src/')));
});

test('syntax errors from interpreters keep the v0.2 path', () => {
  assert.equal(fp(real('python-syntax.txt'), 'python3 syn.py').diagnostics, false);
  assert.equal(fp(real('node-syntax.txt'), 'node syn.js').diagnostics, false);
});

test('different failures stay different', () => {
  assert.notEqual(fp(real('cargo-test-a.txt'), 'cargo test').hash, fp(real('cargo-test-b.txt'), 'cargo test').hash);
  assert.notEqual(fp(real('go-test-a.txt'), 'go test ./...').hash, fp(real('go-test-b.txt'), 'go test ./...').hash);
  assert.notEqual(fp(real('gcc-make.txt'), 'make').hash, fp(real('clang-make.txt'), 'make').hash);
  assert.notEqual(fp(real('gcc-link.txt'), 'g++ c.cpp').hash, fp(real('go-build.txt'), 'go build').hash);
});

test('fixing one of several errors is progress, not a repeat', () => {
  const all = real('gcc-make.txt');
  const fewer = all.split('\n').filter((l) => !/undeclared_b/.test(l)).join('\n');
  assert.notEqual(fp(all, 'make').hash, fp(fewer, 'make').hash);
});

test('monorepo: the same error in several packages is not one error (fixing one package is progress)', () => {
  const pk = (ps) => `Exit code 2\n${ps.map((p) => `packages/${p}/src/index.ts(1,20): error TS2307: Cannot find module '@acme/util'.`).join('\n')}`;
  assert.notEqual(fp(pk(['a', 'b', 'c']), 'tsc -b').hash, fp(pk(['a', 'b']), 'tsc -b').hash);
  assert.equal(fp(pk(['a', 'b']), 'tsc -b').hash, fp(pk(['b', 'a']), 'tsc -b').hash);
});

test('the same error several times in one file: fixing one occurrence is progress', () => {
  const one = (n) => `Exit code 2\n${Array.from({ length: n }, (_, i) => `src/a.ts(${i * 10 + 1},5): error TS2304: Cannot find name 'foo'.`).join('\n')}`;
  assert.notEqual(fp(one(5), 'tsc').hash, fp(one(4), 'tsc').hash);
  assert.equal(fp(one(4), 'tsc').hash, fp(one(4).replace(/\((\d+),5\)/g, (m, n) => `(${Number(n) + 3},5)`), 'tsc').hash);
});

test('excerpt is the first real diagnostic, not a progress line', () => {
  assert.equal(fp(real('ninja.txt'), 'ninja').excerpt, 'a.cpp: fatal error: missing_header.h: No such file or directory');
  assert.equal(fp(real('cargo-build.txt'), 'cargo build').excerpt, 'src/main.rs: error E0425: cannot find value `y` in this scope');
  assert.equal(fp(real('tsc-pretty.txt'), 'tsc').excerpt, "a.ts: error TS2322: Type 'string' is not assignable to type 'number'.");
  assert.equal(fp(real('gcc-link.txt'), 'g++ c.cpp').excerpt, "c.cpp: error: undefined reference to `foo()'");
});

// ---------- Unreal Engine ----------

test('Unreal UBT on Windows: order, action counts, timings and line numbers do not matter', () => {
  const a = fp(ue('ubt-win-run1.txt'), UE_BUILD);
  const b = fp(ue('ubt-win-run2.txt'), UE_BUILD);
  assert.equal(a.diagnostics, true);
  assert.equal(a.hash, b.hash);
  assert.equal(a.excerpt, "ShooterGame/Private/ShooterCharacter.cpp: error C2065: 'AmmoCount': undeclared identifier");
  assert.notEqual(fp(ue('ubt-win-run3-progress.txt'), UE_BUILD).hash, a.hash, 'one error fixed is progress');
  assert.doesNotMatch(a.detail, /note:|warning C4996|Result: Failed|\[\d+\/\d+\]/);
});

test('Unreal is recognised from the log alone, even through a wrapper script', () => {
  assert.equal(fp(ue('ubt-win-run1.txt'), './scripts/build-editor.sh').hash, fp(ue('ubt-win-run2.txt'), 'pwsh ci/build.ps1').hash);
});

test('Unreal on Linux: clang errors and lld undefined symbols', () => {
  const d = fp(ue('ubt-linux.txt'), 'Engine/Build/BatchFiles/Linux/Build.sh ShooterGameEditor Linux Development -Project=x.uproject');
  assert.equal(d.diagnostics, true);
  assert.match(d.detail, /ShooterCharacter\.cpp: error: use of undeclared identifier 'AmmoCount'/);
  assert.match(d.detail, /ld\.lld: error: undefined symbol: UWeaponComponent::Reload\(int\)/);
});

test('UnrealHeaderTool errors are fingerprinted per header', () => {
  const d = fp(ue('uht.txt'), UE_BUILD);
  assert.match(d.detail, /WeaponComponent\.h: error: Unrecognized type 'FAmmoInfo'/);
  assert.match(d.detail, /ShooterCharacter\.h: error: #include found after \.generated\.h/);
});

test('LNK2019 with renumbered unity files is the same error', () => {
  const a = fp(ue('lnk2019-run1.txt'), UE_BUILD);
  assert.equal(a.hash, fp(ue('lnk2019-run2.txt'), UE_BUILD).hash);
  assert.match(a.detail, /error LNK2019: unresolved external symbol/);
  assert.match(a.detail, /fatal error LNK1120/);
});

test('Unreal automation tests: log prefixes and [Line: N] are noise, the values are not', () => {
  const a = fp(ue('automation-run1.txt'), UE_TESTS);
  assert.equal(a.hash, fp(ue('automation-run2.txt'), UE_TESTS).hash);
  assert.notEqual(a.hash, fp(ue('automation-run3-progress.txt'), UE_TESTS).hash);
  assert.match(a.detail, /Path=\{ShooterGame\.Weapons\.Reload\}/);
});

test('AutomationTool (BuildCookRun) cook failures', () => {
  const d = fp(ue('uat-cook.txt'), 'RunUAT.bat BuildCookRun -project=x.uproject -cook');
  assert.match(d.detail, /LogCook: error: Package Arena\.umap references missing asset BP_Rifle/);
  assert.match(d.detail, /ExitCode=25 \(Error_UnknownCookFailure\)/);
});

test('Unreal log prefix and unity file numbers are stripped by the generic normalizer too', () => {
  assert.equal(normalize('[2026.11.26-21.45.13:123][  0]LogTemp: Error: boom'), normalize('[2027.01.02-08.01.02:999][417]LogTemp: Error: boom'));
  assert.equal(normalize('Module.ShooterGame.2.cpp.obj failed'), normalize('Module.ShooterGame.11.cpp.obj failed'));
  assert.equal(normalize('Module.ShooterGame.gen.3.cpp'), normalize('Module.ShooterGame.gen.1.cpp'));
});

// ---------- MSVC / MSBuild / dotnet / Windows ----------

test('MSBuild multi-process prefixes, project suffixes and the error summary', () => {
  // MSBuild prints each error while building and again in the summary after "Build FAILED."
  const run1 = 'Exit code 1\n  2>Foo.cpp\n  2>C:\\src\\acme\\app\\Foo.cpp(12,5): error C2065: \'x\': undeclared identifier [C:\\src\\acme\\app\\app.vcxproj]\n'
    + '  3>Bar.cs(7,20): error CS0103: The name \'y\' does not exist in the current context [C:\\src\\acme\\lib\\lib.csproj]\nBuild FAILED.\n\n'
    + '"C:\\src\\acme\\app.sln" (default target) (1) ->\n  C:\\src\\acme\\app\\Foo.cpp(12,5): error C2065: \'x\': undeclared identifier [C:\\src\\acme\\app\\app.vcxproj]\n'
    + '  Bar.cs(7,20): error CS0103: The name \'y\' does not exist in the current context [C:\\src\\acme\\lib\\lib.csproj]\n    0 Warning(s)\n    2 Error(s)\nTime Elapsed 00:00:04.12';
  const run2 = 'Exit code 1\n  1>Bar.cs(9,20): error CS0103: The name \'y\' does not exist in the current context [D:\\a\\acme\\lib\\lib.csproj]\n'
    + '  4>D:\\a\\acme\\app\\Foo.cpp(15,5): error C2065: \'x\': undeclared identifier [D:\\a\\acme\\app\\app.vcxproj]\nBuild FAILED.\n\n'
    + '"D:\\a\\acme\\app.sln" (default target) (1) ->\n  Bar.cs(9,20): error CS0103: The name \'y\' does not exist in the current context [D:\\a\\acme\\lib\\lib.csproj]\n'
    + '  D:\\a\\acme\\app\\Foo.cpp(15,5): error C2065: \'x\': undeclared identifier [D:\\a\\acme\\app\\app.vcxproj]\n    0 Warning(s)\n    2 Error(s)\nTime Elapsed 00:00:09.87';
  const a = fp(run1, 'msbuild app.sln /m');
  assert.equal(a.hash, fp(run2, 'msbuild app.sln /m').hash);
  assert.equal(a.excerpt, "acme/app/Foo.cpp: error C2065: 'x': undeclared identifier");
});

test('Windows paths with spaces, and a drive letter change between machines', () => {
  const a = "Exit code 2\nC:\\Program Files\\My Game\\Source\\Game\\Hero.cpp(10): error C2143: syntax error: missing ';' before '}'";
  const b = "Exit code 2\nE:\\Work Area\\My Game\\Source\\Game\\Hero.cpp(11): error C2143: syntax error: missing ';' before '}'";
  assert.equal(fp(a, 'cl /c Hero.cpp').hash, fp(b, 'cl /c Hero.cpp').hash);
  assert.equal(fp(a, 'cl /c Hero.cpp').excerpt, "Source/Game/Hero.cpp: error C2143: syntax error: missing ';' before '}'");
});

test('warnings promoted to errors (C2220, /WX) keep the warning that caused them', () => {
  const t = (w) => `Exit code 2\nA.cpp(3): error C2220: the following warning is treated as an error\nA.cpp(9): warning ${w}: 'p': unreferenced formal parameter`;
  assert.notEqual(fp(t('C4100'), 'cl /WX A.cpp').hash, fp(t('C4189'), 'cl /WX A.cpp').hash);
});

test('localised compilers (German gcc, French MSVC, Japanese clang) are recognised', () => {
  for (const [a, b] of [
    ["x.c:3:5: Fehler: »y« nicht deklariert", "x.c:9:5: Fehler: »y« nicht deklariert"],
    ["x.cpp(3): erreur C2065: 'y' : identificateur non déclaré", "x.cpp(30): erreur C2065: 'y' : identificateur non déclaré"],
    ['x.cpp:3:5: エラー: use of undeclared identifier', 'x.cpp:12:5: エラー: use of undeclared identifier'],
  ]) {
    const fa = fp(`Exit code 1\n${a}`, 'make');
    assert.equal(fa.diagnostics, true, a);
    assert.equal(fa.hash, fp(`Exit code 1\n${b}`, 'make').hash, a);
  }
});

test('CRLF line endings and ANSI colours do not change the fingerprint', () => {
  const t = real('clang-make.txt');
  assert.equal(fp(t.replace(/\n/g, '\r\n'), 'make').hash, fp(t, 'make').hash);
  assert.equal(fp(t.replace(/error:/g, '\x1b[31merror:\x1b[0m'), 'make').hash, fp(t, 'make').hash);
});

// ---------- more toolchains and wrappers ----------

test('monorepo task prefixes (turbo, pnpm -r, docker compose) are stripped before matching', () => {
  const a = "Exit code 1\nweb:build: src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\nweb:build: ERROR: command finished with error";
  const b = "Exit code 1\npackages/web build: src/a.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.";
  assert.equal(fp(a, 'turbo run build').hash, fp(b, 'pnpm -r build').hash);
});

test('prefixed lines that only match after the prefix is removed (rust, go)', () => {
  const a = 'Exit code 1\napi-1  | ./main.go:3:27: undefined: y\napi-1 exited with code 1';
  const b = 'Exit code 1\napi-1  | ./main.go:9:27: undefined: y\napi-1 exited with code 1';
  assert.equal(fp(a, 'docker compose run api go build ./...').excerpt, 'main.go: error: undefined: y');
  assert.equal(fp(a, 'docker compose run api go build ./...').hash, fp(b, 'docker compose run api go build ./...').hash);
  const r = 'Exit code 1\ncore:build: error[E0425]: cannot find value `y` in this scope\ncore:build:  --> src/lib.rs:1:46';
  assert.equal(fp(r, 'turbo run build').excerpt, 'src/lib.rs: error E0425: cannot find value `y` in this scope');
});

test('generic normalizer: linker temp objects and code-frame gutters', () => {
  assert.equal(normalize('/usr/bin/ld: /tmp/ccyqhxXF.o: in function'), normalize('/usr/bin/ld: /tmp/ccBAbWaF.o: in function'));
  assert.equal(normalize('/usr/bin/ld: /tmp/c-df8c86.o: in function'), normalize('/usr/bin/ld: /tmp/c-0a1b2c.o: in function'));
  assert.equal(normalize('    > 3 |   expect(sum(1, 2)).toBe(4);'), normalize('    > 13 |   expect(sum(1, 2)).toBe(4);'));
  assert.notEqual(normalize('expected 3 | got 4'), normalize('expected 3 | got 5'));
});

test('Kotlin, Maven, Swift, mypy, Bazel and pyright formats', () => {
  const cases = [
    ['./gradlew build', 'e: file:///w/app/src/Main.kt:12:5 Unresolved reference: foo', 'app/src/Main.kt: error: Unresolved reference: foo'],
    ['mvn compile', '[ERROR] /w/src/main/java/Foo.java:[12,5] cannot find symbol', 'main/java/Foo.java: error: cannot find symbol'],
    ['swift build', "/w/Sources/App/main.swift:3:1: error: cannot find 'x' in scope", "Sources/App/main.swift: error: cannot find 'x' in scope"],
    ['mypy .', 'app/models.py:12: error: Incompatible return value type (got "str", expected "int")  [return-value]', 'app/models.py: error: Incompatible return value type (got "str", expected "int") [return-value]'],
    ['bazel build //app', 'ERROR: /w/app/BUILD:12:8: Compiling app/main.cc failed: (Exit 1): gcc failed: error executing command', 'w/app/BUILD: error: Compiling app/main.cc failed: (Exit 1): gcc failed: error executing command'],
    ['pyright', '  /w/app/x.py:4:7 - error: "foo" is not defined (reportUndefinedVariable)', 'w/app/x.py: error: "foo" is not defined (reportUndefinedVariable)'],
  ];
  for (const [cmd, line, want] of cases) assert.equal(fp(`Exit code 1\n${line}`, cmd).excerpt, want, cmd);
});

test('Apple ld undefined symbols', () => {
  const t = 'Exit code 1\nUndefined symbols for architecture arm64:\n  "_foo", referenced from:\n      _main in main.o\nld: symbol(s) not found for architecture arm64\nclang: error: linker command failed with exit code 1';
  const d = fp(t, 'xcodebuild -scheme App');
  assert.match(d.detail, /undefined symbol _foo/);
});

// ---------- false positives: when NOT to switch to diagnostics ----------

test('a stray "file:line: error:" in a test log does not hide changing assertions', () => {
  const t = (v) => `Exit code 1\nserver.js:12: error: connection refused\nAssertionError: expected 200 got ${v}`;
  assert.equal(tc.signature(t(500), 'npm test'), null);
  assert.notEqual(fp(t(500), 'npm test').hash, fp(t(404), 'npm test').hash);
});

test('a message ending in ":" keeps its next lines, so changed values still differ (gtest on Windows)', () => {
  const t = (v) => `Exit code 2\nC:\\w\\test\\math_test.cpp(12): error: Expected equality of these values:\n  add(1, 2)\n    Which is: ${v}\n  4\n[  FAILED  ] Math.Add (0 ms)`;
  assert.notEqual(fp(t(3), 'make test').hash, fp(t(5), 'make test').hash);
  assert.equal(fp(t(3), 'make test').hash, fp(t(3).replace('(12)', '(19)'), 'make test').hash);
  assert.match(fp(t(3), 'make test').excerpt, /Which is: 3/);
});

test('non-build failures under build-like commands keep their values (no false repeats)', () => {
  const cases = [
    ['./gradlew test', (v) => `Exit code 1\n> Task :app:test FAILED\nFooTest > adds() FAILED\n    org.opentest4j.AssertionFailedError: expected: <4> but was: <${v}>\n        at app//FooTest.adds(FooTest.java:12)\n\nFAILURE: Build failed with an exception.\n* What went wrong:\nExecution failed for task ':app:test'.\nBUILD FAILED in 4s`],
    ['dotnet test', (v) => `Exit code 1\n  Failed Calc.Tests.Adds [3 ms]\n  Error Message:\n   Assert.Equal() Failure: Values differ\nExpected: 4\nActual:   ${v}\n  Stack Trace:\n     at Calc.Tests.Adds() in /app/Tests.cs:line 12\nFailed!  - Failed:     1, Passed:     0`],
    ['npm run build', (v) => `Exit code 1\nvite v5.4.0 building for production...\nerror during build:\n[vite]: Rollup failed to resolve import "${v}" from "/app/src/main.ts".`],
    ['npm run build', (v) => `Exit code 1\nFailed to compile.\n\n./src/app/page.tsx:3:1\nType error: Cannot find name '${v}'.\n\n> 3 | ${v}()\n    | ^`],
    ['docker build .', (v) => `Exit code 1\n#9 [4/6] RUN npm ci\n#9 2.315 npm ERR! 404 Not Found - GET https://registry.npmjs.org/${v}\n#9 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1\nERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1`],
    ['make test', (v) => `Exit code 2\npython -m pytest\nE       assert ${v} == 4\ntests/test_m.py:5: AssertionError\nmake: *** [Makefile:3: test] Error 1`],
    ['bun run build', (v) => `Exit code 1\nAssertionError: expected 3 got ${v}\nerror: script "build" exited with code 1`],
    ['cargo build', (v) => `Exit code 101\nerror: failed to select a version for the requirement \`serde = "^${v}"\``],
  ];
  for (const [cmd, out] of cases) {
    assert.notEqual(fp(out('3'), cmd).hash, fp(out('5'), cmd).hash, cmd);
    assert.equal(fp(out('3'), cmd).hash, fp(out('3'), cmd).hash, cmd);
  }
});

test('webpack "ERROR in" keeps the message from the following line', () => {
  const w = (mod, line) => `Exit code 1\nERROR in ./src/index.js ${line}:0-24\nModule not found: Error: Can't resolve './${mod}' in '/app/src'\n\nwebpack 5.90.0 compiled with 1 error in 312 ms`;
  assert.equal(fp(w('missing', 3), 'npm run build').hash, fp(w('missing', 9), 'npm run build').hash);
  assert.notEqual(fp(w('missing', 3), 'npm run build').hash, fp(w('other', 3), 'npm run build').hash);
});

test('cargo test failures are not reduced to "error: test failed"', () => {
  assert.equal(tc.signature(real('cargo-test-a.txt'), 'cargo test'), null);
});

test('a project build.sh is not mistaken for Unreal; any build command still works', () => {
  assert.equal(tc.isUnrealCommand('./build.sh --release'), false);
  assert.equal(tc.isBuildCommand('./build.sh --release'), false);
  assert.equal(tc.isBuildCommand('Engine/Build/BatchFiles/Build.bat X Win64 Development'), true);
  assert.equal(tc.isBuildCommand('npm run build'), true);
  assert.equal(tc.isBuildCommand('cmake --build out -j 8'), true);
  assert.equal(tc.isBuildCommand('npm test'), false);
  assert.equal(tc.isBuildCommand('pytest -x'), false);
});

// ---------- huge logs ----------

test('a 6 MB build log with the error at the end is found quickly', () => {
  const progress = Array.from({ length: 60000 }, (_, i) => `[${i + 1}/60001] Compile [x64] Module.Engine.${i}.cpp`).join('\n');
  const t = `Exit code 6\n${progress}\nC:\\p\\Source\\Hero.cpp(10): error C2065: 'x': undeclared identifier\nResult: Failed`;
  assert.ok(t.length > 2e6);
  const start = process.hrtime.bigint();
  const d = fp(t, UE_BUILD);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(d.excerpt, "p/Source/Hero.cpp: error C2065: 'x': undeclared identifier");
  assert.ok(ms < 5000, `took ${ms} ms`); // about 150 ms on a laptop; loose for slow CI runners
});

test('generic output over 50k characters keeps its end, where the error is', () => {
  const pad = 'x'.repeat(80000);
  assert.notEqual(hashError('Bash', `${pad}\nTypeError: a`), hashError('Bash', `${pad}\nTypeError: b`));
});

test('a 200 KB single-line template error and pathological lines do not hang', () => {
  const t = `Exit code 2\nA.cpp(3): error C2664: ${'std::vector<std::map<int, '.repeat(8000)}>`;
  const evil = `Exit code 1\n${'a('.repeat(3000)}: error: x\n${':1'.repeat(3000)}\n${'e: '.repeat(3000)}`;
  const start = Date.now();
  fp(t, 'cl A.cpp'); fp(evil, 'make');
  assert.ok(Date.now() - start < 5000);
});

test('the number of diagnostics in a fingerprint is capped', () => {
  const t = `Exit code 1\n${Array.from({ length: 3000 }, (_, i) => `f${i}.c:1:1: error: e${i}`).join('\n')}`;
  assert.equal(tc.extractDiagnostics(t).lines.length, 500);
});

test('secrets in diagnostics are redacted', () => {
  const d = fp('Exit code 1\napp.ts(3,1): error TS2304: Cannot find name ghp_abcdefghijklmnopqrstuvwxyz0123', 'tsc');
  assert.doesNotMatch(d.excerpt, /ghp_/);
});

// ---------- engine: hints, timeouts, silent failures, generated files ----------

function ctxFor(over = {}) {
  return {
    state: { sessionId: 's', timeline: [], errors: {}, cmdFails: {}, pendingEdits: [], fileEdits: {}, warned: {}, deniedDiffs: {}, stops: 0, lastErrorHash: null },
    memory: { failures: {} },
    cfg: { ...DEFAULTS, ignore: [], ...over },
    now: '2026-11-26T10:00:00.000Z',
    projectDir: '/w/game',
  };
}
const fail = (ctx, command, error, tool = 'Bash') => handle({ hook_event_name: 'PostToolUseFailure', tool_name: tool, tool_input: { command }, error }, ctx);
const ctxText = (r) => (r && r.output && r.output.hookSpecificOutput && r.output.hookSpecificOutput.additionalContext) || '';

test('Live Coding: a hint on the first failure, once per session, then the normal loop rules', () => {
  const ctx = ctxFor();
  const r1 = fail(ctx, UE_BUILD, ue('live-coding.txt'));
  assert.match(ctxText(r1), /Live Coding is active/);
  assert.deepEqual(r1.events.map((e) => e.rule), ['hint-live-coding']);
  const r2 = fail(ctx, UE_BUILD, ue('live-coding.txt'));
  assert.doesNotMatch(ctxText(r2), /compile from the editor/);
  assert.match(ctxText(r2), /2nd time this exact error/);
  const r3 = fail(ctx, UE_BUILD, ue('live-coding.txt'));
  assert.ok(r3.stop);
});

test('environment hints: locked file, out of memory, disk full, conflicting UBT', () => {
  const cases = [
    [ue('link-locked.txt'), 'file-locked'],
    ['Exit code 137\n', 'out-of-memory'],
    ['Exit code 1\n<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'out-of-memory'],
    ['Exit code 2\nA.cpp(1): fatal error C1060: compiler is out of heap space', 'out-of-memory'],
    ['Exit code 1\nwrite /var/lib/docker/x: no space left on device', 'disk-full'],
    ["Exit code 1\nError: EBUSY: resource busy or locked, rename 'C:\\app\\dist'", 'file-locked'],
    ['Exit code 6\nA conflicting instance of UnrealBuildTool is already running.', 'ubt-busy'],
  ];
  for (const [err, id] of cases) {
    const r = fail(ctxFor(), 'make', err);
    assert.ok(r.events && r.events.some((e) => e.rule === `hint-${id}`), `${id}: ${err.slice(0, 40)}`);
  }
  assert.equal(fail(ctxFor({ hints: false }), 'make', 'Exit code 137\n').output, undefined);
});

test('a build that hits the shell timeout is not a repeated error; a test that does still is', () => {
  const build = ctxFor();
  for (let i = 0; i < 4; i++) {
    const r = fail(build, UE_BUILD, 'Command timed out after 2m 0.0s');
    assert.ok(!r.stop, `build stopped on run ${i + 1}`);
    if (i === 0) assert.match(ctxText(r), /Unreal builds can take longer than the shell timeout/);
  }
  const tests = ctxFor();
  fail(tests, 'npm test', 'Command timed out after 2m 0.0s');
  fail(tests, 'npm test', 'Command timed out after 2m 0.0s');
  assert.ok(fail(tests, 'npm test', 'Command timed out after 2m 0.0s').stop);
});

test('build timeouts do not count against a later test timeout with the same message', () => {
  const ctx = ctxFor();
  for (let i = 0; i < 3; i++) fail(ctx, 'make -j8', 'Command timed out after 2m 0.0s');
  assert.ok(!fail(ctx, 'npm test', 'Command timed out after 2m 0.0s').stop);
  assert.doesNotMatch(ctxText(fail(ctx, 'npm test', 'Command timed out after 2m 0.0s')), /3rd/);
});

test('timed-out builds still stop at the same-command limit', () => {
  const ctx = ctxFor();
  let stopped = 0;
  for (let i = 1; i <= 6; i++) if (fail(ctx, 'cargo build', 'Command timed out after 10m 0.0s').stop) stopped = i;
  assert.equal(stopped, 6);
});

test('Unreal editor automation that exits 0 with failed tests counts as a failure', () => {
  const ctx = ctxFor();
  const post = () => handle({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: UE_TESTS }, tool_response: { stdout: ue('automation-run1.txt'), stderr: '' } }, ctx);
  post();
  const r = post();
  assert.match(ctxText(r), /2nd time this exact error came back/);
  assert.equal(r.output.hookSpecificOutput.hookEventName, 'PostToolUse');
  const ok = handle({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: UE_TESTS }, tool_response: { stdout: 'Test Completed. Result={Success} Name={A}\n**** TEST COMPLETE. EXIT CODE: 0 ****' } }, ctx);
  assert.equal(ctxText(ok), '');
  assert.equal(tc.silentFailure('npx jest', { stdout: 'Result={Fail}' }), 0, 'only for Unreal editor test runs');
});

test('editing generated files warns once per file', () => {
  const ctx = ctxFor();
  const pre = (file) => handle({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: `/w/game/${file}`, old_string: 'a', new_string: 'b' } }, ctx);
  assert.match(ctxText(pre('Intermediate/Build/Win64/UnrealEditor/Inc/Game/UHT/Hero.generated.h')), /generated by UnrealHeaderTool/);
  assert.equal(ctxText(pre('Intermediate/Build/Win64/UnrealEditor/Inc/Game/UHT/Hero.generated.h')), '');
  assert.match(ctxText(pre('api/v1/user.pb.go')), /generated from a \.proto file/);
  assert.match(ctxText(pre('node_modules/left-pad/index.js')), /installed dependency/);
  assert.equal(ctxText(pre('Source/Game/Hero.cpp')), '');
  assert.equal(ctxText(handle({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/w/game/x.pb.go', old_string: 'a', new_string: 'b' } }, ctxFor({ generatedFiles: 'off' }))), '');
});

test('PowerShell tool failures count like Bash, including $LASTEXITCODE masking', () => {
  const ctx = ctxFor();
  fail(ctx, 'dotnet build', 'Exit code 1\nProgram.cs(3,1): error CS0103: x', 'PowerShell');
  assert.match(ctxText(fail(ctx, 'dotnet build', 'Exit code 1\nProgram.cs(5,1): error CS0103: x', 'PowerShell')), /2nd time/);
  assert.equal(maskedExitCode('dotnet test; echo "EXIT:$LASTEXITCODE"', { stdout: 'EXIT:1' }), 1);
  assert.equal(maskedExitCode('dotnet test & echo EXIT:%ERRORLEVEL%', { stdout: 'EXIT:3' }), 3);
});

test('command normalization: tee, Select-Object and PowerShell exit echoes', () => {
  assert.equal(normalizeCommand('make -j8 2>&1 | tee build.log'), 'make -j8');
  assert.equal(normalizeCommand('dotnet build 2>&1 | Select-Object -Last 40'), 'dotnet build');
  assert.equal(normalizeCommand('dotnet build; echo "EXIT:$LASTEXITCODE"'), 'dotnet build');
  assert.equal(normalizeCommand('npm test | tail -50'), 'npm test');
});
