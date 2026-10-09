import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { CASES, PINS, SETTINGS, LIMITS, SEED, campaign, chooseThree, summarize } from './protocol.mjs';
import { hash, jsonHash, sameWork, verifySubject } from './cached-object-read-protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [mode, rootsArg, outArg] = process.argv.slice(2);
assert.ok(['check', 'measure'].includes(mode));
assert.ok(rootsArg && outArg && process.argv.length === 5);
const roots = JSON.parse(readFileSync(resolve(rootsArg), 'utf8')), out = resolve(outArg);
assert.deepEqual(Object.keys(roots).sort(), Object.keys(PINS).sort());
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args]);
const text = (root, ...args) => git(root, ...args).toString().trim();
const files = root => {
  const found = [];
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'no links in retained package trees');
      if (entry.isDirectory()) walk(child); else found.push(child);
    }
  };
  walk(root);
  return found.sort().map(path => [relative(root, path), hash(readFileSync(path))]);
};
function sourceGuard() {
  assert.equal(process.versions.node, SETTINGS.node); assert.equal(process.arch, 'x64');
  assert.equal(process.platform, 'linux'); assert.equal(process.execArgv.length, 0);
  assert.equal(execFileSync('bun', ['--version']).toString().trim(), SETTINGS.bun);
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:BUN_JSC_|JSC_)/.test(key) || ['NODE_OPTIONS', 'BUN_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(key)) {
      assert.ok(!value, 'runtime override forbidden: ' + key);
    }
  }
  const repo = roots.refinement;
  const a = git(repo, 'show', PINS.baseline + ':arena.ts').toString();
  const b = git(repo, 'show', PINS.original + ':arena.ts').toString();
  const c = git(repo, 'show', PINS.refinement + ':arena.ts').toString();
  const anchor = '    let slot = this.reads?.slot(key);\n';
  const insertion = '    if (code === 0 || code === 4) {\n      const leaf = sorted ? this.radixFind(root, key) : this.find(root, key);\n      return leaf ? this.leafValue(type, leaf, prefix) : undefined;\n    }\n';
  assert.equal(a.split(anchor).length, 2); assert.equal(b, a.replace(anchor, insertion + anchor));
  const redundant = 'code !== 0 && code !== 4 && slot !== undefined';
  assert.equal(b.split(redundant).length, 4); assert.equal(c, b.replaceAll(redundant, 'slot !== undefined'));
  assert.equal(text(repo, 'rev-parse', PINS.refinement + '^'), PINS.original);
  assert.equal(text(repo, 'rev-parse', PINS.refinement + '^{tree}'), '4dabf1e3e9ec76d4a81e2e17999ceb888bc5e826');
  assert.deepEqual(text(repo, 'diff', '--name-only', PINS.original, PINS.refinement).split('\n'), ['arena.ts']);
  assert.deepEqual(text(repo, 'diff', '--name-only', PINS.baseline, PINS.original).split('\n').sort(), ['arena.ts', 'cached-object-read.test.ts']);
  const expected = read(join(here, 'reference-builds.json')), builds = {};
  for (const role of Object.keys(PINS)) {
    const root = resolve(roots[role]); assert.equal(roots[role], root);
    assert.equal(text(root, 'rev-parse', 'HEAD'), PINS[role]);
    assert.equal(text(root, 'diff', 'HEAD', '--name-only'), '', 'all tracked inputs must match exact commit');
    const source = {};
    for (const name of text(root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')) {
      source[name] = hash(git(root, 'show', 'HEAD:' + name));
      assert.equal(hash(readFileSync(join(root, name))), source[name]);
    }
    const compiler = {
      version: read(join(root, 'node_modules/assemblyscript/package.json')).version,
      entrySha256: hash(readFileSync(join(root, 'node_modules/assemblyscript/bin/asc.js'))),
      implementationSha256: hash(readFileSync(join(root, 'node_modules/assemblyscript/dist/asc.js'))),
    };
    const toolchain = Object.fromEntries(['typescript', 'bun-types', 'vitest'].map(name => [name, read(join(root, 'node_modules', name, 'package.json')).version]));
    assert.deepEqual(toolchain, { typescript: '5.9.3', 'bun-types': '1.4.2', vitest: '4.1.11' });
    const dist = files(join(root, 'dist'));
    const wasm = readdirSync(root).filter(name => name.endsWith('.wasm')).sort().map(name => [name, hash(readFileSync(join(root, name)))]);
    const lockSha256 = hash(readFileSync(join(root, 'bun.lock')));
    assert.equal(lockSha256, hash(readFileSync(join(here, 'frozen-bun.lock'))));
    assert.equal(lockSha256, '9a66d94c2fbd6c9d37917c53264f8c08ac58a42a6c75eb425dd905539eb1a1fe');
    assert.deepEqual(dist, expected[role].dist, 'built bytes must match untimed frozen reference');
    assert.deepEqual(wasm, expected[role].wasm); assert.deepEqual(compiler, expected[role].compiler);
    builds[role] = { sourceSha: PINS[role], sourceTree: text(root, 'rev-parse', 'HEAD^{tree}'),
      sourceGitBlobsSha256: hash(git(root, 'ls-tree', '-r', 'HEAD')), source, dist, wasm, compiler, toolchain, lockSha256 };
  }
  const harnessFiles = files(here).filter(([name]) => name !== 'intent.json');
  return { schema: 1, pins: PINS, settings: SETTINGS, limits: LIMITS, seed: SEED,
    harnessFiles, harnessDigest: jsonHash(harnessFiles), builds,
    environment: { node: process.version, bun: execFileSync('bun', ['--version']).toString().trim(),
      bunExecutableSha256: hash(readFileSync(execFileSync('which', ['bun']).toString().trim())),
      nodeExecutableSha256: hash(readFileSync(process.execPath)), platform: process.platform, arch: process.arch,
      cpus: os.cpus(), release: os.release(), totalMemory: os.totalmem(), execPath: process.execPath },
  };
}
const manifest = sourceGuard(), neutral = join(out, 'subject'), packagePath = join(neutral, 'package'), inputPath = join(neutral, 'input.json');
const intent = read(join(here, 'intent.json'));
assert.deepEqual(Object.keys(intent).sort(), ['schema', 'measure', 'reviewedHarnessSha256', 'checkedManifestSha256'].sort());
assert.equal(intent.schema, 1);
if (mode === 'check') {
  assert.equal(intent.measure, false); mkdirSync(out); save(join(out, 'manifest.json'), manifest);
} else {
  assert.equal(intent.measure, true, 'measurement is disabled until exact-harness review');
  assert.equal(intent.reviewedHarnessSha256, manifest.harnessDigest);
  assert.equal(intent.checkedManifestSha256, hash(readFileSync(join(out, 'manifest.json'))));
  const previous = read(join(out, 'manifest.json'));
  assert.equal(previous.harnessDigest, manifest.harnessDigest); assert.deepEqual(previous.builds, manifest.builds);
  for (const key of ['node', 'bun', 'nodeExecutableSha256', 'bunExecutableSha256', 'platform', 'arch', 'release']) assert.equal(previous.environment[key], manifest.environment[key]);
  const checked = read(join(out, 'checked.json')); assert.equal(checked.passed, true); assert.equal(checked.timed, false);
}
mkdirSync(neutral, { recursive: true });
for (const name of ['cached-object-read-protocol.mjs', 'cached-object-read-subject.mjs', 'cached-object-read-workloads.mjs']) cpSync(join(here, name), join(neutral, name));
function stage(role) {
  assert.deepEqual(files(join(roots[role], 'dist')), manifest.builds[role].dist);
  rmSync(packagePath, { recursive: true, force: true }); mkdirSync(packagePath);
  cpSync(join(roots[role], 'dist'), join(packagePath, 'dist'), { recursive: true });
  writeFileSync(join(packagePath, 'package.json'), '{"type":"module","private":true}\n');
  assert.equal(realpathSync(packagePath), packagePath); return jsonHash(files(packagePath));
}
const seenPids = new Set();
function subject(config, runtime, role, directory, ordinal, reference, timeout = LIMITS.processMs) {
  const prefix = join(directory, String(ordinal).padStart(5, '0')), packageDigest = stage(role);
  const executable = runtime === 'node' ? process.execPath : 'bun';
  const args = [join(neutral, 'cached-object-read-subject.mjs'), inputPath];
  writeFileSync(inputPath, JSON.stringify(config) + '\n');
  const started = new Date().toISOString();
  save(prefix + '.started.json', { config, runtime, role, executable, args, cwd: neutral, packageDigest, started, timeout });
  const run = spawnSync(executable, args, { cwd: neutral, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(prefix + '.stdout.jsonl', run.stdout ?? '', { flag: 'wx' });
  writeFileSync(prefix + '.stderr.txt', run.stderr ?? '', { flag: 'wx' });
  save(prefix + '.process.json', { started, ended: new Date().toISOString(), pid: run.pid, status: run.status, signal: run.signal, error: run.error?.message });
  assert.equal(run.error, undefined); assert.equal(run.status, 0);
  // This cloud environment injects one Node proxy warning. Preserve and permit
  // exactly that warning only in untimed Node checks; Bun timing stays strict.
  const nodeCheckWarning = `(node:${run.pid}) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.\n(Use \`node --trace-warnings ...\` to show where the warning was created)\n`;
  assert.ok(run.stderr === '' || (runtime === 'node' && config.phase === 'check' && run.stderr === nodeCheckWarning), 'unexpected subject stderr');
  assert.ok(!seenPids.has(run.pid), 'fresh process PID must be distinct'); seenPids.add(run.pid);
  const lines = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.filter(x => x.event === 'result').length, 1); assert.ok(!lines.some(x => x.event === 'failure'));
  assert.equal(lines.at(-1).event, 'result'); const result = lines.at(-1).result;
  assert.equal(result.runtime.pid, run.pid); assert.deepEqual(result.runtime.execArgv, []);
  verifySubject(result, { ...config, runtime, packageDigest }); if (reference) sameWork(reference, result);
  return result;
}
if (mode === 'check') {
  const directory = join(out, 'checks'); mkdirSync(directory); const results = []; let ordinal = 0;
  for (const runtime of ['node', 'bun']) for (const spec of CASES) for (const role of Object.keys(PINS)) {
    const reference = results.find(x => x.workload === spec.id)?.result;
    const result = subject({ phase: 'check', workload: spec.id }, runtime, role, directory, ordinal++, reference);
    results.push({ runtime, workload: spec.id, role, result });
  }
  save(join(out, 'checked.json'), { passed: true, timed: false, harnessDigest: manifest.harnessDigest, results });
  console.log(JSON.stringify({ passed: true, timed: false, checks: results.length, harnessDigest: manifest.harnessDigest }));
} else {
  const directory = join(out, 'campaign'); mkdirSync(directory); // Exclusive: no resume, overwrite, rerun, or replacement.
  const started = performance.now(), remaining = () => Math.floor(LIMITS.campaignMs - (performance.now() - started));
  const plan = campaign(), checked = read(join(out, 'checked.json')), measured = [], outcomes = [], pilotFailures = [], work = {};
  save(join(directory, 'plan.json'), { seed: SEED, plan, samplesPerSubject: 21 });
  save(join(directory, 'manifest.json'), manifest); save(join(directory, 'intent.json'), intent);
  const pilotDir = join(directory, 'pilots'), measureDir = join(directory, 'measurements'); mkdirSync(pilotDir); mkdirSync(measureDir);
  let ordinal = 0;
  for (const spec of CASES) {
    const pilots = [], reference = checked.results.find(x => x.workload === spec.id).result;
    for (const role of Object.keys(PINS)) {
      try {
        assert.ok(remaining() > 0, 'campaign ceiling reached');
        pilots.push(subject({ phase: 'pilot', workload: spec.id }, 'bun', role, pilotDir, ordinal, reference, Math.min(LIMITS.processMs, remaining())));
      } catch (error) { pilotFailures.push({ workload: spec.id, role, ordinal, message: error.message }); }
      ordinal++;
    }
    if (pilots.length === 3) try { work[spec.id] = chooseThree(pilots); } catch (error) { pilotFailures.push({ workload: spec.id, message: error.message }); }
  }
  save(join(directory, 'fixed-work.json'), work); save(join(directory, 'pilot-failures.json'), pilotFailures);
  for (const [ordinal, item] of plan.entries()) {
    let valid = false, reason;
    try {
      assert.equal(pilotFailures.length, 0, 'pilot failure: no measured subjects may start');
      assert.ok(remaining() > 0, 'campaign ceiling reached: remaining subject not started');
      const reference = checked.results.find(x => x.workload === item.workload).result;
      const result = subject({ phase: 'measure', workload: item.workload, ...work[item.workload] }, 'bun', item.role,
        measureDir, ordinal, reference, Math.min(LIMITS.processMs, remaining()));
      measured.push({ ...item, result }); valid = true;
    } catch (error) { reason = error.message; }
    const outcome = { ...item, ordinal, valid, ...(reason ? { reason } : {}) }; outcomes.push(outcome);
    save(join(measureDir, String(ordinal).padStart(5, '0') + '.outcome.json'), outcome);
  }
  const summary = summarize(measured, outcomes); save(join(directory, 'summary.json'), summary);
  console.log(JSON.stringify({ complete: summary.complete, validSubjects: summary.validSubjects, focusedDiagnosticClear: summary.focusedDiagnosticClear, globalClearance: false }));
  if (!summary.complete) process.exitCode = 1;
}
