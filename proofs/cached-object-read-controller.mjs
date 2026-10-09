import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { CASES, PINS, SETTINGS, SCHEDULE_SEED, campaign, chooseWork, decide, hash, jsonHash, sameWork, summarizeCell, verifySubject } from './cached-object-read-protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const proofNames = [
  'cached-object-read-protocol.mjs', 'cached-object-read-workloads.mjs',
  'cached-object-read-subject.mjs', 'cached-object-read-controller.mjs',
  'cached-object-read-protocol.node.mjs', 'cached-object-read-performance.md', 'cached-object-read-reference.py',
];
const [mode, repoArg, baselineArg, candidateArg, outArg, reviewedDigest] = process.argv.slice(2);
assert.ok(['check', 'measure'].includes(mode), 'mode is check or measure');
assert.ok(repoArg && baselineArg && candidateArg && outArg);
const repo = resolve(repoArg), out = resolve(outArg);
const roots = { baseline: resolve(baselineArg), candidate: resolve(candidateArg) };
const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
const text = (...args) => git(...args).toString().trim();
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const files = root => {
  const found = [];
  const walk = path => {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, e.name);
      assert.ok(!e.isSymbolicLink(), 'no links in evidence/package trees');
      if (e.isDirectory()) walk(child); else found.push(child);
    }
  };
  walk(root);
  return found.sort().map(path => [relative(root, path), hash(readFileSync(path))]);
};
mkdirSync(out, { recursive: true });
const neutral = join(out, 'subject');
const packagePath = join(neutral, 'package');
const inputPath = join(neutral, 'input.json');
function sourceGuard() {
  assert.equal(process.versions.node, SETTINGS.node);
  assert.equal(process.arch, SETTINGS.arch);
  assert.equal(execFileSync('bun', ['--version']).toString().trim(), SETTINGS.bun);
  for (const name of ['NODE_OPTIONS', 'BUN_OPTIONS', 'BUN_JSC_forceRAMSize', 'BUN_JSC_useJIT']) {
    assert.ok(!process.env[name], 'unexpected runtime override: ' + name);
  }
  const before = git('show', PINS.baseline + ':arena.ts').toString();
  const after = git('show', PINS.candidate + ':arena.ts').toString();
  const anchor = '    const leaf = sorted ? this.radixFind(root, key) : this.find(root, key);\n    // A root change can still resolve to the exact same immutable leaf.';
  const insertion = '    if ((code === 0 || code === 4) && slot !== undefined && this.reads.root(slot) === root) {\n      const leaf = this.reads.leaf(slot);\n      return leaf ? this.leafValue(type, leaf, prefix) : undefined;\n    }\n';
  assert.equal(before.split(anchor).length, 2);
  assert.equal(after, before.replace(anchor, insertion + anchor));
  assert.deepEqual(text('diff', '--name-only', PINS.baseline, PINS.candidate).split('\n').sort(),
    ['arena.ts', 'cached-object-read.test.ts']);
  const readCache = git('show', PINS.candidate + ':read-cache.ts').toString();
  assert.ok(readCache.includes('MAX_CHARS = 131072'));
  assert.ok(readCache.includes('this.chars + key.length > ReadCache.MAX_CHARS'));
  assert.ok(after.includes('this.objects.size < 2048 && this.objectBytes + len <= 2097152'));
  assert.equal(text('rev-parse', PINS.correctness + '^'), PINS.candidate);
  const harnessFiles = proofNames.map(name => [name, hash(readFileSync(join(here, name)))]);
  harnessFiles.push(['.github/workflows/cached-object-read-performance.yml',
    hash(readFileSync(join(repo, '.github/workflows/cached-object-read-performance.yml')))]);
  const builds = {};
  for (const role of ['baseline', 'candidate']) {
    const root = roots[role];
    assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), PINS[role]);
    const dirtySource = execFileSync('git', ['-C', root, 'diff', '--name-only', '--', '*.ts', '*.json', '*.mjs']).toString().trim();
    assert.equal(dirtySource, '', 'tracked source/build inputs must match source pin');
    const source = {};
    for (const path of text('ls-tree', '-r', '--name-only', PINS[role]).split('\n')
      .filter(path => !path.includes('/') && /\.(ts|json)$/.test(path) || /^scripts\/build-/.test(path))) {
      const bytes = git('show', PINS[role] + ':' + path);
      source[path] = hash(bytes);
      assert.equal(hash(readFileSync(join(root, path))), source[path]);
    }
    const dist = files(join(root, 'dist'));
    const wasm = readdirSync(root).filter(name => name.endsWith('.wasm')).sort().map(name => [name, hash(readFileSync(join(root, name)))]);
    assert.ok(wasm.some(([name]) => name === 'persistent-core.wasm'));
    builds[role] = { sourceSha: PINS[role], sourceTree: text('rev-parse', PINS[role] + '^{tree}'),
      sourceGitBlobsSha256: hash(git('ls-tree', '-r', PINS[role])), source,
      dist, wasm, compiler: {
        version: JSON.parse(readFileSync(join(root, 'node_modules/assemblyscript/package.json'), 'utf8')).version,
        entrySha256: hash(readFileSync(join(root, 'node_modules/assemblyscript/bin/asc.js'))),
        implementationSha256: hash(readFileSync(join(root, 'node_modules/assemblyscript/dist/asc.js'))),
      },
      buildCommands: ['bun run build:wasm', 'bun run build:browser', 'bun run build:types'],
      buildWasmScriptSha256: hash(readFileSync(join(root, 'scripts/build-wasm.mjs'))),
      buildBrowserScriptSha256: hash(readFileSync(join(root, 'scripts/build-browser.ts'))),
    };
  }
  const references = {};
  for (const role of ['baseline', 'candidate']) {
    const reference = JSON.parse(readFileSync(join(out, 'references', role, 'receipt.json'), 'utf8'));
    references[role] = reference;
    assert.equal(reference.sourceSha, PINS[role]);
    assert.equal(reference.correctnessProof, PINS.correctness);
    assert.equal(reference.correctnessRun, PINS.correctnessRun);
    assert.deepEqual(builds[role].dist, reference.dist, 'new dist must exactly match frozen correctness artifact');
    assert.deepEqual(builds[role].wasm, reference.wasm, 'new WASM must match frozen correctness artifact');
    assert.equal(builds[role].compiler.implementationSha256, reference.compilerImplementationSha256);
  }
  assert.equal(references.baseline.lockSha256, references.candidate.lockSha256);
  assert.deepEqual(builds.baseline.wasm, builds.candidate.wasm, 'unchanged WASM must produce identical bytes');
  assert.deepEqual(builds.baseline.compiler, builds.candidate.compiler);
  assert.equal(builds.baseline.compiler.version, '0.28.20');
  return { schema: 1, pins: PINS, settings: SETTINGS, seed: SCHEDULE_SEED,
    proofCommit: text('rev-parse', 'HEAD'), proofTree: text('rev-parse', 'HEAD^{tree}'),
    intent: JSON.parse(readFileSync(join(here, 'cached-object-read-run.json'), 'utf8')),
    intentSha256: hash(readFileSync(join(here, 'cached-object-read-run.json'))), harnessFiles,
    harnessDigest: jsonHash(harnessFiles), builds, references,
    environment: { platform: process.platform, arch: process.arch, node: process.version,
      bun: execFileSync('bun', ['--version']).toString().trim(), cpus: os.cpus(), release: os.release(),
      totalMemory: os.totalmem(), execPath: process.execPath },
  };
}
function prepareNeutral() {
  mkdirSync(neutral, { recursive: true });
  for (const name of ['cached-object-read-protocol.mjs', 'cached-object-read-workloads.mjs', 'cached-object-read-subject.mjs']) {
    cpSync(join(here, name), join(neutral, name));
  }
}
function stage(role) {
  // One physical package directory, never a symlink or role-specific import URL.
  assert.deepEqual(files(join(roots[role], 'dist')), manifest.builds[role].dist, 'built package changed during campaign');
  rmSync(packagePath, { recursive: true, force: true });
  mkdirSync(packagePath);
  cpSync(join(roots[role], 'dist'), join(packagePath, 'dist'), { recursive: true });
  writeFileSync(join(packagePath, 'package.json'), JSON.stringify({ type: 'module', private: true }) + '\n');
  assert.equal(realpathSync(packagePath), packagePath);
  return jsonHash(files(packagePath));
}
function subject(config, runtime, role, directory, ordinal, reference) {
  const packageDigest = stage(role);
  writeFileSync(inputPath, JSON.stringify(config) + '\n');
  const executable = runtime === 'node' ? process.execPath : 'bun';
  const args = [join(neutral, 'cached-object-read-subject.mjs'), inputPath];
  const started = new Date().toISOString();
  const run = spawnSync(executable, args, { cwd: neutral, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  const prefix = join(directory, String(ordinal).padStart(5, '0'));
  writeFileSync(prefix + '.stdout.jsonl', run.stdout ?? '', { flag: 'wx' });
  writeFileSync(prefix + '.stderr.txt', run.stderr ?? '', { flag: 'wx' });
  save(prefix + '.process.json', { config, runtime, role, executable, args, cwd: neutral, packageDigest,
    started, ended: new Date().toISOString(), pid: run.pid, status: run.status, signal: run.signal, error: run.error?.message });
  assert.equal(run.error, undefined, 'subject process error');
  assert.equal(run.status, 0, 'subject failed; raw output retained');
  const lines = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.filter(e => e.event === 'result').length, 1);
  assert.ok(!lines.some(e => e.event === 'failure'));
  const result = lines.at(-1).result;
  assert.equal(lines.at(-1).event, 'result');
  verifySubject(result, { ...config, runtime, packageDigest });
  if (reference) sameWork(reference, result);
  return result;
}
const manifest = sourceGuard();
prepareNeutral();
if (mode === 'check') {
  const directory = join(out, 'checks');
  mkdirSync(directory); // Deliberately fails if this evidence destination exists.
  save(join(out, 'manifest.json'), manifest);
  const results = [];
  let ordinal = 0;
  for (const runtime of ['node', 'bun']) for (const spec of CASES) {
    let reference;
    for (const role of ['baseline', 'candidate']) {
      const result = subject({ phase: 'check', workload: spec.id }, runtime, role, directory, ordinal++, reference);
      reference ??= result;
      results.push({ runtime, workload: spec.id, role, result });
    }
  }
  // Deterministic fixture bytes must also agree across Node and Bun.
  for (const spec of CASES) {
    const matching = results.filter(r => r.workload === spec.id);
    for (const other of matching) sameWork(matching[0].result, other.result);
  }
  save(join(out, 'checked.json'), { passed: true, timed: false, harnessDigest: manifest.harnessDigest, results });
  console.log(JSON.stringify({ passed: true, timed: false, checks: results.length, harnessDigest: manifest.harnessDigest }));
} else {
  assert.equal(reviewedDigest, manifest.harnessDigest, 'independently reviewed exact harness digest required');
  const checked = JSON.parse(readFileSync(join(out, 'checked.json'), 'utf8'));
  const originalManifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(checked.passed, true); assert.equal(checked.timed, false);
  assert.equal(checked.harnessDigest, manifest.harnessDigest);
  assert.deepEqual(originalManifest.builds, manifest.builds, 'builds changed after validation');
  const directory = join(out, 'campaign');
  mkdirSync(directory); // No overwrite, resume, subject replacement, or rerun mode.
  const plan = campaign();
  save(join(directory, 'plan.json'), { seed: SCHEDULE_SEED, plan, subjectsPerCell: 48, samplesPerSubject: 21 });
  save(join(directory, 'manifest.json'), manifest);
  const pilotDir = join(directory, 'pilots'), measureDir = join(directory, 'measurements');
  mkdirSync(pilotDir); mkdirSync(measureDir);
  const work = new Map(), failures = [], measured = [];
  let ordinal = 0;
  // Every disposable pilot in both runtimes finishes before any measurement.
  for (const runtime of ['node', 'bun']) for (const spec of CASES) {
    const pilots = [];
    const reference = checked.results.find(r => r.runtime === runtime && r.workload === spec.id).result;
    for (const role of ['baseline', 'candidate']) {
      try { pilots.push(subject({ phase: 'pilot', workload: spec.id }, runtime, role, pilotDir, ordinal++, reference)); }
      catch (error) { failures.push({ phase: 'pilot', runtime, workload: spec.id, role, message: error.message }); }
    }
    if (pilots.length === 2) {
      try { work.set(runtime + '/' + spec.id, chooseWork(pilots)); }
      catch (error) { failures.push({ phase: 'pilot-plan', runtime, workload: spec.id, message: error.message }); }
    }
  }
  save(join(directory, 'fixed-work.json'), Object.fromEntries(work));
  save(join(directory, 'pilot-failures.json'), failures);
  assert.equal(failures.length, 0, 'pilot failure: no measurements started, no rerun');
  ordinal = 0;
  for (const item of plan) {
    const common = work.get(item.runtime + '/' + item.workload);
    const reference = checked.results.find(r => r.runtime === item.runtime && r.workload === item.workload).result;
    try {
      const result = subject({ phase: 'measure', workload: item.workload, ...common }, item.runtime, item.role,
        measureDir, ordinal, reference);
      measured.push({ ...item, result });
    } catch (error) {
      failures.push({ ...item, ordinal, message: error.message });
    }
    // This record is written once regardless of failure. No subject is repeated.
    save(join(measureDir, String(ordinal).padStart(5, '0') + '.outcome.json'),
      { ...item, ordinal, valid: measured.at(-1)?.result && measured.at(-1)?.runtime === item.runtime
          && !failures.some(f => f.ordinal === ordinal) ? true : false });
    ordinal++;
  }
  save(join(directory, 'failures.json'), failures);
  const cells = [];
  for (const runtime of ['node', 'bun']) for (const spec of CASES) {
    const records = measured.filter(r => r.runtime === runtime && r.workload === spec.id);
    const cellFailures = failures.filter(r => r.runtime === runtime && r.workload === spec.id);
    if (cellFailures.length || records.length !== 48) {
      cells.push({ runtime, workload: spec.id, invalid: true, failures: cellFailures, validSubjects: records.length });
    } else cells.push({ runtime, workload: spec.id, summary: summarizeCell(records) });
  }
  const conclusion = cells.some(c => c.invalid) ? { verdict: 'invalid-campaign', strongClear: false, failures: failures.length } : decide(cells);
  save(join(directory, 'summary.json'), { cells, conclusion, totalScheduled: plan.length, validSubjects: measured.length,
    limitation: 'Four independent quartets per comparison; t intervals are model-based. Within-process samples do not increase independent replication.' });
  console.log(JSON.stringify(conclusion));
  if (cells.some(c => c.invalid)) process.exitCode = 1;
}
