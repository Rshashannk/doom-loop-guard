'use strict';
// Toolchain awareness: compilers, linkers, build systems and game engines.
//
// Build output is the hardest input for a loop detector. Parallel builds print
// errors in a different order each run, code frames carry line numbers, and the
// real error can sit at the end of megabytes of progress lines. When a failure
// is clearly a build failure, we fingerprint only its error diagnostics: each
// reduced to file name + severity + code + message, de-duplicated and sorted.
//
// Everything here is pure: no file or network access.
const { normalize, redact, SRC_EXT } = require('./normalize');

const MAX_SCAN_CHARS = 20e6;   // same cap as the stdin reader in guard.js
const MAX_LINE = 4000;         // C++ template errors can be one 50 KB line
const MAX_DIAGS = 500;
const CANON_MAX = 300;

// "Error" in the languages compilers are commonly localised to.
const ERR_WORD = '(fatal error|error|Error|ERROR|Fehler|schwerwiegender Fehler|erreur(?: fatale)?|errore(?: irreversibile)?|error fatal|fout|błąd|chyba|hiba|hata|ошибка|критическая ошибка|エラー|致命的なエラー|오류|错误|致命错误|錯誤|嚴重錯誤)';
const COLON = '\\s*[:：]';
const CODE = '([A-Z]{1,4}\\d{3,5})'; // C2065, LNK2019, TS2322, CS0103, X3004, MSB3073

// Each pattern returns { file, sev, code, msg, anchored }. "anchored" means the
// line has a location or an error code, so it cannot be a stray log line.
const PATTERNS = [
  // MSVC, MSBuild, dotnet, tsc, UnrealHeaderTool, fxc:  path(12,5): error C2065: msg
  { re: new RegExp(`^\\s*(?:\\d+>)?(.+?)\\((\\d+)(?:[,-]\\d+){0,3}\\)\\s*${COLON}\\s*${ERR_WORD}(?:\\s+${CODE})?${COLON}\\s*(.*)$`),
    map: (m) => ({ file: m[1], sev: m[3], code: m[4], msg: m[5], anchored: true }) },
  // MSVC linker / tools without a line:  x.obj : error LNK2019: msg   LINK : fatal error LNK1104: msg
  { re: new RegExp(`^\\s*(?:\\d+>)?(.+?)\\s+${COLON}\\s*${ERR_WORD}\\s+${CODE}${COLON}\\s*(.*)$`),
    map: (m) => ({ file: m[1], sev: m[2], code: m[3], msg: m[4], anchored: true }) },
  // tsc --pretty, pyright:  a.ts:1:7 - error TS2322: msg
  { re: new RegExp(`^\\s*(.+?):(\\d+):(\\d+)\\s+-\\s+${ERR_WORD}(?:\\s+${CODE})?${COLON}\\s*(.*)$`),
    map: (m) => ({ file: m[1], sev: m[4], code: m[5], msg: m[6], anchored: true }) },
  // Bazel:  ERROR: /path/BUILD:12:8: Compiling foo.cc failed: (Exit 1)
  { re: /^ERROR:\s+(.+?):(\d+):(\d+):\s*(.*)$/,
    map: (m) => ({ file: m[1], sev: 'error', msg: m[4], anchored: true }) },
  // gcc, clang, swiftc, javac, mypy, nvcc:  a.cpp:1:10: fatal error: msg   Foo.java:1: error: msg
  { re: new RegExp(`^(.+?):(\\d+)(?::(\\d+))?${COLON}\\s*${ERR_WORD}${COLON}\\s*(.*)$`),
    map: (m) => ({ file: m[1], sev: m[4], msg: m[5], anchored: true }) },
  // Kotlin:  e: file:///x/Foo.kt:12:5 Unresolved reference: x
  { re: /^e:\s+(?:file:\/\/)?(.+?):(\d+):(\d+)\s+(.*)$/,
    map: (m) => ({ file: m[1], sev: 'error', msg: m[4], anchored: true }) },
  // Maven:  [ERROR] /x/Foo.java:[12,5] cannot find symbol
  { re: /^\[ERROR\]\s+(.+?):\[(\d+),(\d+)\]\s*(.*)$/,
    map: (m) => ({ file: m[1], sev: 'error', msg: m[4], anchored: true }) },
  // rustc:  error[E0425]: msg   (the file comes from the next " --> " line)
  { re: /^(error)\[(E\d{4})\]:\s*(.*)$/,
    map: (m) => ({ file: '', sev: m[1], code: m[2], msg: m[3], anchored: true, rust: true }) },
  // GNU ld / lld / Apple ld
  { re: /^(.+?):\(\.[\w.$]+\+0x[0-9a-f]+\):\s*((?:undefined reference to|multiple definition of) .*)$/i,
    map: (m) => ({ file: m[1], sev: 'error', msg: m[2], anchored: true }) },
  { re: /^(ld(?:\.lld|\.gold|\.bfd)?|lld-link|wasm-ld|ld64\.lld):\s*error:\s*(.*)$/,
    map: (m) => ({ file: m[1], sev: 'error', msg: m[2], anchored: true }) },
  { re: /^(Undefined symbols for architecture \S+?):?$/,
    map: (m) => ({ file: 'ld', sev: 'error', msg: m[1], anchored: true }) },
  { re: /^\s+"(.+)", referenced from:$/,
    map: (m) => ({ file: 'ld', sev: 'error', msg: `undefined symbol ${m[1]}`, anchored: true }) },
  // Go:  ./main.go:3:27: undefined: y      main_test.go:3: expected 3 got 2
  { re: /^\s{0,4}(?:\.\/)?([^\s:]+\.go):(\d+)(?::(\d+))?:\s+(.*)$/,
    map: (m) => ({ file: m[1], sev: 'error', msg: m[4], anchored: true }) },
  // tool-prefixed, no location:  clang++: error: linker command failed   collect2: error: ld returned 1
  { re: new RegExp(`^([\\w.+-]+)${COLON}\\s*${ERR_WORD}${COLON}\\s*(.*)$`),
    map: (m) => ({ file: m[1], sev: m[2], msg: m[3], anchored: false }) },
];

// Unreal Engine log lines, after the "[2026.11.26-21.45.13:123][  0]" prefix.
const UE_LOG = /^(?:Log\w+:\s+Display:\s+)?(Log\w+):\s+(Error|Fatal):\s*(.*)$/;
const UE_TEST_FAIL = /Test Completed\. Result=\{Fail(?:ed)?\}\s*(Name=\{[^}]*\})?\s*(Path=\{[^}]*\})?/;
const UE_PLAIN = /^(?:ERROR|Error):\s*(.*)$/;
const UE_PREFIX = /^\[\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3}\]\[\s*\d+\]/;
const UAT_EXIT = /AutomationTool exit(?:ing|ed) with ExitCode=(\d+) \((\w+)\)/;

// Summaries whose numbers change as errors get fixed: never part of a fingerprint.
const SUMMARY = /^(?:error: could not compile .* due to \d+ previous errors?.*|error: aborting due to .*|\d+ errors? generated\.?|Found \d+ errors?.*|\d+ errors?$|error: test failed, to rerun.*|error: build failed|error: Recipe .* failed.*|fatal error: too many errors emitted.*)$/i;
// Warnings promoted to errors: the warning line is the real content.
const PROMOTED = /\b(?:C2220|treated as an? error|warnings being treated as errors|-Werror)\b/;
const MSVC_WARN = /^\s*(?:\d+>)?(.+?)\((\d+)(?:[,-]\d+){0,3}\)\s*:\s*warning\s+([A-Z]{1,4}\d{3,5}):\s*(.*)$/;
const RUST_LOC = /^\s*-->\s*(.+?):(\d+):(\d+)\s*$/;
const MSBUILD_PROJ = /\s+\[[^\]]+\.(?:vcx|cs|fs|vb|sql|wix)?proj\]\s*$/i;
// Turbo, pnpm -r, docker compose, lerna, nx prefixes in front of compiler lines.
const TASK_PREFIX = /^(?:[@\w./-]+(?:[: ][\w:@./-]+)?\s*(?:\|\s|:\s)|#\d+\s+\d+(?:\.\d+)?\s+)/;
// Cheap test before running the patterns on a line.
const MAYBE = /error|Error|ERROR|Fehler|erreur|errore|fout|błąd|chyba|hiba|hata|ошибка|エラー|오류|错误|錯誤|undefined reference|multiple definition|Undefined symbols|referenced from|\.go:\d|^e: |\s-->\s|warning\s+[A-Z]{1,4}\d|Unable to build|ExitCode=|Result=\{Fail/;

const UNREAL_CMD = /UnrealBuildTool|UnrealEditor|UE4Editor|RunUAT|RunUBT|UnrealHeaderTool|BatchFiles|\.uproject\b|\.uplugin\b|LiveCodingConsole/i;
const UNREAL_TEXT = /UnrealBuildTool|UnrealHeaderTool|AutomationTool exit|\.generated\.h\b|Live Coding|LogInit:|LogAutomationController|\[\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3}\]\[\s*\d+\]Log\w+:/;

// Commands that compile, link, type-check or lint. Their failures are build
// diagnostics, and their reruns are incremental.
const BUILD_TOOLS = [
  'make', 'gmake', 'mingw32-make', 'nmake', 'jom', 'ninja', 'cmake', 'meson', 'scons', 'msbuild', 'devenv', 'cl', 'clang-cl', 'link',
  'clang', 'clang\\+\\+', 'gcc', 'g\\+\\+', 'c\\+\\+', 'cc', 'nvcc', 'icx', 'icpx', 'zig', 'emcc', 'em\\+\\+',
  'dotnet', 'csc', 'cargo', 'rustc', 'go', 'javac', 'kotlinc', 'gradlew?', 'mvnw?', 'sbt', 'ant', 'bazel(?:isk)?', 'buck2?', 'pants',
  'xcodebuild', 'swift', 'swiftc', 'tsc', 'vue-tsc', 'svelte-check', 'mypy', 'pyright', 'eslint', 'nx', 'turbo', 'lerna',
  'flutter', 'dart', 'Unity', 'godot', 'UnrealBuildTool', 'UnrealEditor-Cmd', 'UnrealEditor', 'UE4Editor-Cmd', 'UE4Editor', 'RunUAT', 'RunUBT', 'Build',
];
const BUILD_CMD = new RegExp(`(?:^|[\\s;&|/\\\\"'(])(?:${BUILD_TOOLS.join('|')})(?:\\.(?:exe|bat|cmd|sh|command|dll))?(?=$|[\\s"')])`, 'i');
const SCRIPT_BUILD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|compile|typecheck|type-check|tsc|lint|check)\b/i;
// Markers that say "this text is a build log" even when the command is a wrapper script.
const BUILD_TEXT = /\b(?:make(?:\[\d+\])?: \*\*\*|ninja: build stopped|FAILED: \S|\d+ errors? generated|compilation terminated|could not compile|collect2: error|ld returned \d+ exit status|linker command failed|BUILD FAILED|Build FAILED|\*\* BUILD FAILED \*\*|Compilation failure|Execution failed for task|UnrealBuildTool|error MSB\d{4})/;

function isUnrealCommand(cmd) { return UNREAL_CMD.test(String(cmd || '')); }
function hasUnrealMarkers(text) { return UNREAL_TEXT.test(String(text || '').slice(0, 2e6)); }
function isBuildCommand(cmd) {
  const c = String(cmd || '');
  if (!c) return false;
  // Unreal's Build.bat / Build.sh only, not any project's build.sh
  if (/(?:^|[\s/\\"'])Build\.(?:bat|sh|command)\b/i.test(c) && !UNREAL_CMD.test(c)) {
    return BUILD_CMD.test(c.replace(/(?:^|[\s/\\"'])Build\.(?:bat|sh|command)\b/gi, ' '));
  }
  return BUILD_CMD.test(c) || SCRIPT_BUILD.test(c);
}

const basename = (p) => {
  const s = String(p || '').trim().replace(/^["']|["']$/g, '').replace(/^file:\/+/, '/');
  const parts = s.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
};

// Messages keep their meaning but lose paths, numbers that move, and noise.
function canonMessage(msg) {
  let m = String(msg || '').replace(MSBUILD_PROJ, '');
  m = m.replace(/\[File:[^\]]*?([^\\/\]]+)\]/g, '[File:$1]').replace(/\[Line:\s*\d+\]/g, '[Line: <N>]');
  m = m.replace(new RegExp(`\\b([\\w.-]+\\.(?:${SRC_EXT}))\\((\\d+)(?:[,-]\\d+){0,3}\\)`, 'gi'), '$1(<N>)');
  return normalize(m).replace(/\n/g, ' ');
}

function canon(d) {
  const file = normalize(basename(d.file).replace(/:$/, ''));
  const sev = /fatal|schwerwiegend|irreversibile|критическая|致命/i.test(d.sev || '') ? 'fatal error' : 'error';
  const head = [file && `${file}:`, sev, d.code].filter(Boolean).join(' ');
  const line = `${head}: ${canonMessage(d.msg)}`;
  return line.length > CANON_MAX ? line.slice(0, CANON_MAX) : line;
}

function matchLine(line) {
  for (const p of PATTERNS) {
    const m = p.re.exec(line);
    if (m) return p.map(m);
  }
  return null;
}

// Unreal's own log formats, tried before the compiler patterns.
function matchUnreal(line) {
  const t = line.trim();
  let m = UE_LOG.exec(t);
  if (m) return { file: m[1], sev: m[2] === 'Fatal' ? 'fatal error' : 'error', msg: m[3], anchored: true };
  if ((m = UE_TEST_FAIL.exec(t))) return { file: 'Automation', sev: 'error', msg: `test failed ${m[1] || ''} ${m[2] || ''}`.trim(), anchored: true };
  if ((m = UAT_EXIT.exec(t))) return m[1] === '0' ? null : { file: 'AutomationTool', sev: 'error', msg: `ExitCode=${m[1]} (${m[2]})`, anchored: true };
  if ((m = UE_PLAIN.exec(t))) return { file: '', sev: 'error', msg: m[1], anchored: true };
  if (/Unable to build while Live Coding is active/i.test(t)) return { file: 'UnrealBuildTool', sev: 'error', msg: t, anchored: true };
  return null;
}

// Walk the whole log once. Returns the error diagnostics in output order.
function extractDiagnostics(text, opts = {}) {
  const s = String(text == null ? '' : text);
  const src = s.length > MAX_SCAN_CHARS ? s.slice(-MAX_SCAN_CHARS) : s;
  const unreal = Boolean(opts.unreal);
  const lines = src.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n|\r/);
  const out = [];
  const seen = new Set();
  let anchored = false;
  let coded = false;
  let promoted = false;
  const warnings = [];
  let pendingRust = null;
  let cont = null; // a message that ends with ':' continues on the next lines (gtest "Expected equality of these values:")
  const add = (d) => {
    const c = canon(d);
    if (SUMMARY.test(c.replace(/^[^:]*: /, '')) || SUMMARY.test(String(d.msg || '').trim())) return;
    if (d.anchored) anchored = true;
    if (d.code) coded = true;
    if (seen.has(c) || out.length >= MAX_DIAGS) return;
    seen.add(c);
    out.push(c);
  };
  const flush = () => { if (cont) { add(cont.d); cont = null; } };
  for (let raw of lines) {
    if (!raw || !MAYBE.test(raw)) {
      if (cont) {
        if (raw && raw.trim()) { cont.d.msg += `\n${raw.trim().slice(0, 200)}`; if (--cont.left <= 0) flush(); } else flush();
      }
      if (pendingRust && raw && raw.trim() && !/\s-->\s/.test(raw)) { add(pendingRust); pendingRust = null; }
      continue;
    }
    flush();
    if (raw.length > MAX_LINE) raw = raw.slice(0, MAX_LINE);
    const loc = RUST_LOC.exec(raw) || RUST_LOC.exec(raw.replace(TASK_PREFIX, ''));
    if (loc && pendingRust) { pendingRust.file = loc[1]; add(pendingRust); pendingRust = null; continue; }
    if (pendingRust) { add(pendingRust); pendingRust = null; }
    let line = raw.replace(UE_PREFIX, '');
    if (PROMOTED.test(line)) promoted = true;
    const w = MSVC_WARN.exec(line);
    if (w) { warnings.push({ file: w[1], sev: 'error', code: w[3], msg: `(warning as error) ${w[4]}`, anchored: true }); continue; }
    let d = unreal ? matchUnreal(line) : null;
    if (!d) d = matchLine(line);
    if (!d && TASK_PREFIX.test(line)) {
      const stripped = line.replace(TASK_PREFIX, '');
      if (stripped !== line) { d = matchLine(stripped); line = stripped; }
    }
    if (!d) continue;
    if (d.rust) { pendingRust = d; continue; }
    if (/:\s*$/.test(String(d.msg || ''))) { cont = { d, left: 4 }; continue; }
    add(d);
  }
  flush();
  if (pendingRust) add(pendingRust);
  if (promoted) for (const w of warnings) add(w);
  return { lines: out, anchored, coded, unreal };
}

// The fingerprint key for a build failure, or null when the generic normalizer
// should be used. Only fires for build commands or text that is clearly a build
// log, and only when at least one diagnostic has a location or an error code.
function signature(errText, command = '') {
  const text = String(errText == null ? '' : errText);
  if (!text) return null;
  const unreal = isUnrealCommand(command) || hasUnrealMarkers(text);
  const buildish = unreal || isBuildCommand(command) || BUILD_TEXT.test(text.length > 4e6 ? text.slice(0, 2e6) + text.slice(-2e6) : text);
  const d = extractDiagnostics(text, { unreal });
  if (!d.lines.length || !d.anchored) return null;
  if (!buildish && !d.coded) return null;
  const exit = /^Exit code (-?\d+)/.exec(text);
  const sorted = [...d.lines].sort();
  return {
    key: `${exit ? `Exit code ${exit[1]}\n` : ''}${sorted.join('\n')}`,
    lines: d.lines.map((l) => redact(l)),
    unreal,
  };
}

// ---------- environment problems: retrying the same command cannot help ----------
const HINTS = [
  { id: 'live-coding', re: /Unable to build while Live Coding is active/i,
    text: 'Unreal: Live Coding is active in a running editor or game, so command-line builds are refused. Rebuilding will keep failing. Ask the user to close the editor, or to compile from the editor with Live Coding (Ctrl+Alt+F11).' },
  { id: 'ubt-busy', re: /conflicting instance of UnrealBuildTool|Waiting for (?:the )?other (?:UBT|UnrealBuildTool) instance/i,
    text: 'Unreal: another UnrealBuildTool is already running (often the editor or an IDE build). Wait for it to finish, or pass -WaitMutex, instead of starting another build.' },
  { id: 'file-locked', re: /LNK1104: cannot open file '[^']*\.(?:dll|exe|lib|pdb|exp)'|LNK1168|LNK1201|being used by another process|\bEBUSY\b|Text file busy|EPERM: operation not permitted, (?:unlink|rename|open)|Access to the path .* is denied/i,
    text: 'A file the build writes is locked by a running program (an editor, the app, a debugger, a test runner or antivirus). Changing code will not fix this. Stop the program that holds the file, or ask the user to, then build again.' },
  { id: 'out-of-memory', re: /\bC1060\b|\bC3859\b|compiler is out of heap space|JavaScript heap out of memory|java\.lang\.OutOfMemoryError|LLVM ERROR: out of memory|cc1plus: out of memory|Killed signal terminated program|fatal error: Killed signal|^Exit code 137\b|signal: killed|virtual memory range for PCH exceeded/im,
    text: 'The build ran out of memory. Code changes will not fix this. Lower the parallelism (for example -j2, -maxcpucount:2, MaxParallelActions in Unreal\'s BuildConfiguration.xml, or --max-old-space-size for Node) or ask the user to free memory.' },
  { id: 'disk-full', re: /No space left on device|\bENOSPC\b|There is not enough space on the disk|\bC1085\b|LNK1318|disk quota exceeded/i,
    text: 'The disk (or a system limit such as file watchers) is full. Code changes will not fix this. Free space, for example build output folders, or ask the user to.' },
];

// Long builds that exceed the shell timeout make progress on every rerun.
function isTimeout(errText) {
  return /\b(?:timed out|timeout of \d+\S* exceeded|Command timed out)\b/i.test(String(errText || '').slice(0, 400));
}

function envHints(errText, command = '') {
  const text = String(errText || '');
  const scan = text.length > 4e6 ? text.slice(0, 2e6) + text.slice(-2e6) : text;
  const out = HINTS.filter((h) => h.re.test(scan)).map(({ id, text: t }) => ({ id, text: t }));
  if (isTimeout(text) && isBuildCommand(command)) {
    out.push({ id: 'build-timeout', text: `${isUnrealCommand(command) ? 'Unreal builds' : 'Large builds'} can take longer than the shell timeout. `
      + 'Finished work is kept, so a rerun continues where it stopped. Run it in the background or with a longer timeout instead of changing code.' });
  }
  return out;
}

// ---------- tools that can exit 0 while reporting failures ----------
// Unreal's editor can return 0 after automation tests fail.
function silentFailure(rawCommand, response) {
  const cmd = String(rawCommand || '');
  if (!/(?:UnrealEditor|UE4Editor)(?:-Cmd)?(?:\.exe)?\b/i.test(cmd) || !/Automation\s+Run(?:Tests|All|Filter)|RunAutomationTests?|-testexit/i.test(cmd)) return 0;
  const r = response && typeof response === 'object' ? response : {};
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (/Result=\{Fail(?:ed)?\}|TEST COMPLETE\. EXIT CODE: [1-9]/.test(out)) return 1;
  return 0;
}

// ---------- files that a tool regenerates: editing them cannot stick ----------
const GENERATED = [
  { re: /\.generated\.h$|\.gen\.cpp$/i, what: 'is generated by UnrealHeaderTool on every build', fix: 'Change the UCLASS/USTRUCT/UPROPERTY declarations in the matching header instead.' },
  { re: /(?:^|\/)Intermediate\/(?:Build|ProjectFiles|Source)\//, what: 'is in Unreal\'s Intermediate folder, which the build regenerates', fix: 'Change the module source, .Build.cs or .Target.cs file instead.' },
  { re: /\.pb\.(?:go|h|cc|cs)$|_pb2(?:_grpc)?\.pyi?$|_grpc\.pb\.(?:go|h|cc)$|\.pb\.swift$/i, what: 'is generated from a .proto file', fix: 'Change the .proto file and regenerate.' },
  { re: /\.g\.(?:cs|dart)$|\.g\.i\.cs$|\.freezed\.dart$/i, what: 'is generated by a code generator', fix: 'Change the source it is generated from and rerun the generator.' },
  { re: /(?:^|\/)__generated__\//, what: 'is in a __generated__ folder', fix: 'Change the schema or source it is generated from and rerun the generator.' },
  { re: /(?:^|\/)node_modules\//, what: 'is an installed dependency, replaced on the next install', fix: 'Fix your own code, or use a patch tool (patch-package, pnpm patch, yarn patch) so the change survives installs.' },
  { re: /(?:^|\/)target\/(?:debug|release)\/|(?:^|\/)obj\/(?:Debug|Release)\/|(?:^|\/)(?:\.next|\.nuxt|\.svelte-kit|\.turbo|\.dart_tool)\//, what: 'is build output, rewritten by the next build', fix: 'Change the source file instead.' },
];

function generatedFile(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  if (!p) return null;
  const g = GENERATED.find((x) => x.re.test(p));
  return g ? { what: g.what, fix: g.fix } : null;
}

module.exports = {
  signature, extractDiagnostics, envHints, isTimeout, silentFailure, generatedFile,
  isBuildCommand, isUnrealCommand, hasUnrealMarkers, canonMessage,
};
