/** Hosted preflight and input freeze. Does not launch a benchmark or a browser. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryHeadroom } from './full-memory-headroom.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Workflow reruns are not recording authorization');
assert.equal(process.version, 'v22.23.3');
assert.equal(process.platform, 'linux');
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
assert.ok(process.env.GITHUB_WORKSPACE?.startsWith('/') && process.env.RUNNER_TEMP?.startsWith('/'));
const root = process.env.GITHUB_WORKSPACE;
const source = fileURLToPath(new URL('.', import.meta.url));
assert.equal(resolve(source), resolve(root, '.github/sharedmap-validation'));
const base = join(process.env.RUNNER_TEMP, 'zerocopy-sharedmap-validation');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const write = (name, value) => writeFileSync(join(base, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const baseline = 'd856ff0bd41745ae0e84d9d726d6aaaf7013fc25';
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
function verifyReviewedSource() {
  assert.equal(git(['rev-parse', 'HEAD']), process.env.GITHUB_SHA);
  const runtimePaths = git(['ls-tree', '-r', '--name-only', baseline]).split('\n')
    .filter(path => !path.includes('/') && /\.(ts|json)$/.test(path));
  for (const path of runtimePaths) {
    assert.equal(git(['rev-parse', `HEAD:${path}`]), git(['rev-parse', `${baseline}:${path}`]), `Runtime source changed: ${path}`);
  }
  const records = execFileSync('git', ['ls-tree', '-rz', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10000 }).split('\0').filter(Boolean);
  const tracked = records.map(record => {
    const [metadata, path] = record.split('\t'), [mode, type, expected] = metadata.split(' ');
    assert.ok(type === 'blob' && ['100644', '100755'].includes(mode), `Unsupported tracked source kind: ${path}`);
    const content = readFileSync(join(root, path));
    const actual = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    assert.equal(actual, expected, `Working source differs from reviewed HEAD: ${path}`);
    return path;
  });
  return { runtimePaths, tracked };
}

if (process.argv[2] === '--preflight') {
  assert.ok(!existsSync(base), 'Use one exclusive directory for this attempt');
  mkdirSync(base);
  const inputs = {}, startedAt = new Date().toISOString();
  try {
    const observed = memoryHeadroom(path => {
      const text = readFileSync(path, 'utf8'); inputs[path] = text; return text;
    });
    assert.ok(observed.effectiveHeadroomBytes >= 3 * 1024 ** 3, 'Require at least 3 GiB effective headroom');
    write('preflight.json', { status: 'verified', startedAt, endedAt: new Date().toISOString(), observed });
  } catch (error) {
    write('preflight.json', { status: 'failed', startedAt, endedAt: new Date().toISOString(),
      error: error.stack ?? String(error), memoryObservation: error.memoryObservation ?? null });
    throw error;
  } finally { write('preflight-inputs.json', inputs); }
} else if (process.argv[2] === '--source') {
  assert.equal(JSON.parse(readFileSync(join(base, 'preflight.json'), 'utf8')).status, 'verified');
  write('source-before-build.json', { sourceCommit: process.env.GITHUB_SHA, ...verifyReviewedSource() });
} else if (process.argv[2] === '--prepare') {
  assert.equal(JSON.parse(readFileSync(join(base, 'preflight.json'), 'utf8')).status, 'verified');
  const { runtimePaths, tracked } = verifyReviewedSource();
  assert.equal(JSON.parse(readFileSync(join(base, 'source-before-build.json'), 'utf8')).sourceCommit, process.env.GITHUB_SHA);
  const paths = JSON.parse(readFileSync(join(source, 'INPUT-PATHS.json'), 'utf8')).map(path => join(root, path));
  paths.push(...readdirSync(join(root, 'dist')).filter(name => name.endsWith('.js')).sort().map(name => join(root, 'dist', name)));
  paths.push(...['full-controller.mjs', 'full-memory-headroom.mjs', 'full-memory-headroom.test.mjs', 'prepare.mjs', 'INPUT-PATHS.json', 'PLAN.md'].map(name => join(source, name)));
  paths.push(join(root, '.github/workflows/sharedmap-validation.yml'), process.execPath);
  paths.push(...tracked.map(path => join(root, path)));
  const uniquePaths = [...new Set(paths)].sort();
  writeFileSync(join(base, 'FULL-INPUTS.sha256'), uniquePaths.map(path => `${sha256(path)}  ${path}\n`).join(''), { flag: 'wx' });
  write('build-provenance.json', { sourceCommit: process.env.GITHUB_SHA, runtimeSourceCommit: process.env.GITHUB_SHA,
    unchangedRuntimeBaseline: baseline, verifiedRuntimeSourcePaths: runtimePaths,
    nodeVersion: process.version, nodeExecutable: process.execPath, nodeSHA256: sha256(process.execPath),
    note: 'This hosted run builds fresh portable dist from this exact branch commit; no local dist or earlier measurements are relabeled.' });
} else throw new Error('Use --preflight, --source or --prepare');
