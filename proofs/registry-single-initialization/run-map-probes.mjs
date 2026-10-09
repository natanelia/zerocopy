import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrumentMapExpressions, loadTypeScript, HOOK } from './instrument.mjs';
import { runToFiles } from './run-to-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROLES = ['main', 'old', 'cleanup'];
const HARNESS = ['run-map-probes.mjs', 'run-to-files.mjs', 'instrument.mjs', 'common.mjs', 'allocation-subject.mjs', 'topology-subject.mjs', 'traversal-subject.mjs', 'heap-subject.mjs'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const errorObject = error => ({ name: error.name, message: error.message, stack: error.stack });

export function manifest(root) {
  const files = [];
  function visit(path) {
    const stat = lstatSync(path);
    assert(!stat.isSymbolicLink(), `Symlinks are not accepted in built inputs: ${path}`);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else {
      assert(stat.isFile(), `Not a regular input file: ${path}`);
      const bytes = readFileSync(path);
      files.push({ file: relative(root, path).split('\\').join('/'), bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  visit(join(root, 'package.json'));
  visit(join(root, 'dist'));
  return files;
}

export function compareResults(records) {
  const find = (lane, role, mode, count, copy) => {
    const found = records.filter(record => record.request.lane === lane && record.request.role === role && record.request.mode === mode && record.request.count === count && record.request.copy === copy);
    assert.equal(found.length, 1, `Missing/duplicate ${lane}/${role}/${mode}/${count}/${copy}`);
    assert.equal(found[0].passed, true, `Failed ${lane}/${role}/${mode}/${count}/${copy}`);
    return found[0].result;
  };
  const comparisons = [];
  for (const [mode, count, copy] of [['attach', 1, false], ['attach', 1, true], ['attach', 512, false], ['attach', 512, true], ['owned', 512, false]]) {
    const old = find('allocation', 'old', mode, count, copy), cleanup = find('allocation', 'cleanup', mode, count, copy);
    const saved = mode === 'attach' && count > 1 ? count : 0;
    assert.equal(old.evaluated - cleanup.evaluated, saved, 'Expected one fewer Map expression per shared-registry arena only');
    assert.equal(old.settledAlive, cleanup.settledAlive, 'Old/cleanup settled instrumented Map count must match');
    assert.equal(old.discarded - cleanup.discarded, saved, 'Saved Maps must have been discarded, not retained');
    const oldTopology = find('topology', 'old', mode, count, copy), cleanupTopology = find('topology', 'cleanup', mode, count, copy);
    assert.deepEqual(oldTopology, cleanupTopology, 'Old/cleanup topology, own slots, read-only and lifetime behavior must match');
    if (mode === 'attach') {
      assert.deepEqual(find('traversal', 'old', mode, count, copy), find('traversal', 'cleanup', mode, count, copy));
      find('heap', 'old', mode, count, copy); find('heap', 'cleanup', mode, count, copy);
    }
    comparisons.push({ mode, count, copy, oldEvaluated: old.evaluated, cleanupEvaluated: cleanup.evaluated,
      discardedMapsRemoved: saved, oldSettledMaps: old.settledAlive, cleanupSettledMaps: cleanup.settledAlive, identicalTopologyLayoutAndLifetime: true });
  }
  // Require the full three-build matrix. Main is an independently asserted
  // natural baseline, not required to have the candidate's sparse topology.
  assert.equal(records.length, 54);
  assert(records.every(record => record.passed));
  for (const role of ROLES) for (const count of [1, 512]) for (const copy of [false, true]) {
    for (const lane of ['allocation', 'topology', 'traversal', 'heap']) find(lane, role, 'attach', count, copy);
  }
  for (const role of ROLES) for (const lane of ['allocation', 'topology']) find(lane, role, 'owned', 512, false);
  return comparisons;
}

export function runMapProbes(mainRoot, oldRoot, cleanupRoot, newOutput, options = {}) {
  assert(newOutput, 'NEW_OUTPUT is required');
  const output = resolve(newOutput), roots = [mainRoot, oldRoot, cleanupRoot].map(root => realpathSync(root));
  assert(!existsSync(output), `Evidence output must be new; refusing to overwrite: ${output}`);
  for (const root of roots) {
    assert(output !== root && !output.startsWith(`${root}/`) && !root.startsWith(`${output}/`), 'Input and evidence roots must be disjoint');
  }
  mkdirSync(output);
  const summary = { schema: 1, passed: false, scope: 'untimed registry-cleanup mechanism and semantics gate',
    createdAt: new Date().toISOString(), host: { node: process.version, versions: process.versions, arch: process.arch, platform: process.platform },
    executable: { path: process.execPath, sha256: sha256(readFileSync(process.execPath)) },
    inputs: {}, archives: {}, probes: [], comparisons: [], errors: [],
    distinctions: ['Map-expression evaluations', 'WeakRef-observed settled Maps', 'Map.prototype traversal calls', 'own property names/order/descriptors', 'descriptive post-GC process memory'],
    physicalObjectLayout: { inspected: false, byteSizeAsserted: false, note: 'Historical 37 in-object slots/320 bytes are not a portable Node 22 assertion.' },
    latencyMeasured: false };
  const save = () => json(join(output, 'summary.json'), summary);
  save();
  try {
    const ts = loadTypeScript(roots, options.typescriptPath);
    summary.parserVersion = ts.version;
    mkdirSync(join(output, 'harness'));
    summary.harness = HARNESS.map(file => {
      const bytes = readFileSync(join(HERE, file)); writeFileSync(join(output, 'harness', file), bytes);
      return { file, bytes: bytes.length, sha256: sha256(bytes) };
    });
    mkdirSync(join(output, 'archives')); mkdirSync(join(output, 'processes'));
    for (const [index, role] of ROLES.entries()) {
      const root = roots[index], before = manifest(root);
      summary.inputs[role] = { root, before };
      save();
      const archive = join(output, 'archives', role);
      mkdirSync(archive); mkdirSync(join(archive, 'original'));
      cpSync(join(root, 'package.json'), join(archive, 'original/package.json'));
      cpSync(join(root, 'dist'), join(archive, 'original/dist'), { recursive: true });
      assert.deepEqual(manifest(join(archive, 'original')), before, `Original ${role} archive does not match input`);
      cpSync(join(archive, 'original'), join(archive, 'instrumented'), { recursive: true });
      const patch = { role, hook: HOOK, parser: ts.version, originalArchive: 'original', instrumentedArchive: 'instrumented', files: [], sites: [] };
      for (const item of before.filter(item => item.file.endsWith('.js'))) {
        const path = join(archive, 'instrumented', item.file), original = readFileSync(path, 'utf8');
        const { code, sites } = instrumentMapExpressions(ts, item.file, original);
        if (sites.length) {
          writeFileSync(path, code);
          patch.files.push({ file: item.file, originalSha256: item.sha256, instrumentedSha256: sha256(code), insertedExpressions: sites.length });
          patch.sites.push(...sites);
        }
      }
      assert(patch.sites.length > 0, 'No native new Map expressions found');
      json(join(archive, 'instrumentation.json'), patch);
      const original = manifest(join(archive, 'original')), instrumented = manifest(join(archive, 'instrumented'));
      json(join(archive, 'original-manifest.json'), original); json(join(archive, 'instrumented-manifest.json'), instrumented);
      summary.archives[role] = { root: archive, original, instrumented, instrumentationSha256: sha256(readFileSync(join(archive, 'instrumentation.json'))) };
      save();
    }
    for (const role of ROLES) {
      for (const [mode, count, copy] of [['attach', 1, false], ['attach', 1, true], ['attach', 512, false], ['attach', 512, true], ['owned', 512, false]]) {
        const lanes = mode === 'owned' ? ['allocation', 'topology'] : ['allocation', 'topology', 'traversal', 'heap'];
        for (const lane of lanes) {
          const request = { lane, role, mode, count, copy, root: join(summary.archives[role].root, lane === 'allocation' ? 'instrumented' : 'original') };
          const id = `${role}-${mode}-${count}-copy-${copy}-${lane}`, subject = join(output, 'harness', `${lane}-subject.mjs`);
          const record = { id, request, passed: false, status: 'running',
            stdout: `processes/${id}.stdout.jsonl`, stderr: `processes/${id}.stderr.log` };
          summary.probes.push(record); save();
          const result = runToFiles(process.execPath, ['--expose-gc', subject, JSON.stringify(request)], {
            timeout: options.timeoutMs ?? 120000,
            env: { ...process.env, NODE_OPTIONS: '' },
            stdoutPath: join(output, record.stdout), stderrPath: join(output, record.stderr),
          });
          Object.assign(record, { status: result.status, signal: result.signal, error: result.error ? errorObject(result.error) : null,
            stdoutSha256: sha256(result.stdout), stderrSha256: sha256(result.stderr) });
          try {
            const events = (result.stdout ?? '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
            record.runtime = events.find(event => event.event === 'start');
            const completed = events.filter(event => event.event === 'result');
            record.failure = events.find(event => event.event === 'failure');
            assert.equal(result.status, 0, `Subject failed: ${id}`);
            assert.equal(completed.length, 1, `Exactly one completed result required: ${id}`);
            assert.equal(events.at(-1).event, 'result');
            assert(!record.failure);
            assert.deepEqual(completed[0].request, request);
            record.result = completed[0].result; record.passed = true;
          } catch (error) { record.validationError = errorObject(error); }
          save();
          // All cells are attempted so a failed/partial gate preserves its
          // independent useful evidence. No timing process can start here.
        }
      }
    }
    summary.comparisons = compareResults(summary.probes);
  } catch (error) { summary.errors.push(errorObject(error)); }
  finally {
    try {
      for (const [role, input] of Object.entries(summary.inputs)) {
        input.after = manifest(input.root);
        assert.deepEqual(input.after, input.before, `Original built input changed: ${role}`);
        const archive = summary.archives[role];
        assert(archive, `Archive incomplete: ${role}`);
        assert.deepEqual(manifest(join(archive.root, 'original')), archive.original, `Archived original changed: ${role}`);
        assert.deepEqual(manifest(join(archive.root, 'instrumented')), archive.instrumented, `Instrumented archive changed: ${role}`);
        assert.equal(sha256(readFileSync(join(archive.root, 'instrumentation.json'))), archive.instrumentationSha256);
      }
      for (const item of summary.harness ?? []) assert.equal(sha256(readFileSync(join(output, 'harness', item.file))), item.sha256);
      summary.integrityVerified = Object.keys(summary.inputs).length === 3 && Object.keys(summary.archives).length === 3;
    } catch (error) { summary.errors.push(errorObject(error)); summary.integrityVerified = false; }
    summary.passed = summary.errors.length === 0 && summary.integrityVerified === true && summary.probes.length === 54 && summary.probes.every(probe => probe.passed) && summary.comparisons.length === 5;
    summary.finishedAt = new Date().toISOString(); save();
  }
  if (!summary.passed) throw new Error(`Untimed map probes failed; preserved evidence: ${join(output, 'summary.json')}`);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 6, 'Usage: node run-map-probes.mjs MAIN_ROOT OLD_ROOT CLEANUP_ROOT NEW_OUTPUT');
    const summary = runMapProbes(...process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ passed: summary.passed, evidence: resolve(process.argv[5]), probes: summary.probes.length })}\n`);
  } catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }
}
