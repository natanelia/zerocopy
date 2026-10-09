/** Prospective, arm-local results-cache hygiene for the heap repair screen.
 * Never imports Vitest, executes a test, or writes to shared dependencies.
 * The caller creates a fresh real root/node_modules directory before preparation.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CACHE_SCHEMA = 'zerocopy-heap-repair-screen-cache/v1';
export const VITEST_VERSION = '4.1.11';
export const PROJECT_CACHE_KEY = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
export const FRESH_RESULTS = '{"version":"4.1.11","results":[]}';
export const FRESH_RESULTS_SHA256 = 'c5cccc1249cd01f91863c9163b69695d817f7039eb87d55989699edf9976ad13';
export const CONFIG_SHA256 = '6bae9f4e513173dec6c089c4fcaf3957c5cb9aa3195173f1d5ace6a60140a489';
export const INSTALLED_SOURCE_SHA256 = Object.freeze({
  'vitest/package.json': 'a28126d97bcaf567da5bed69443b7f3bcd9a7a8c38c8b66e554686b6bb2c10e0',
  'vitest/dist/chunks/cli-api.CnMVyzaz.js': 'a236001d048380e2c67d05423fc9ea3f26b07ee019ba8d6e622082f29d49102e',
  'vitest/dist/chunks/coverage.DM_a_rWm.js': 'e509f3cc1bd81ae6426265253fa926cbde02be5cebfe35b1df422017bffdca31',
  'vitest/dist/chunks/cac.uFydS1Z4.js': '27cc9365d180bee3da005fe6c4d485868caf9d8f54280759eea28842836af549',
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const inside = (path, parent) => path === parent || path.startsWith(parent + sep);
const maybeStat = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const seed = Buffer.from(JSON.stringify({ version: VITEST_VERSION, results: [] }));
assert.equal(seed.toString(), FRESH_RESULTS);
assert.equal(sha256(seed), FRESH_RESULTS_SHA256);
assert.equal(createHash('sha1').update('').digest('hex'), PROJECT_CACHE_KEY);

function realDirectory(path, label) {
  path = resolve(path);
  const info = maybeStat(path);
  assert(info?.isDirectory() && !info.isSymbolicLink(), `${label} must be an actual directory: ${path}`);
  return realpathSync(path);
}
function directoryWithoutLinks(path, create = false) {
  path = resolve(path);
  const parts = [];
  for (let current = path; ; current = dirname(current)) {
    parts.push(current);
    if (dirname(current) === current) break;
  }
  for (const current of parts.reverse()) {
    let info = maybeStat(current);
    if (!info && create) { mkdirSync(current); info = lstatSync(current); }
    assert(info?.isDirectory() && !info.isSymbolicLink(), `Cache/evidence ancestor must be a real directory: ${current}`);
  }
  return path;
}
function armPaths(root) {
  root = realDirectory(root, 'Arm root');
  const nodeModules = join(root, 'node_modules');
  assert.equal(realDirectory(nodeModules, 'Arm node_modules'), nodeModules,
    'Arm node_modules must resolve inside the task-owned arm');
  return { root, nodeModules, cacheDirectory: join(nodeModules, '.vite', 'vitest', PROJECT_CACHE_KEY),
    resultsPath: join(nodeModules, '.vite', 'vitest', PROJECT_CACHE_KEY, 'results.json') };
}
function readRegular(path) {
  const info = maybeStat(path);
  assert(info?.isFile() && !info.isSymbolicLink(), `Expected regular file: ${path}`);
  return readFileSync(path);
}
function writeExclusive(path, bytes) {
  directoryWithoutLinks(dirname(path), true);
  writeFileSync(path, bytes, { flag: 'wx' });
}
const writeJson = (path, value) => writeExclusive(path, JSON.stringify(value, null, 2) + '\n');
function inspectImplementation(sharedNodeModules, root) {
  const sources = Object.entries(INSTALLED_SOURCE_SHA256).map(([path, expected]) => {
    const bytes = readRegular(join(sharedNodeModules, path));
    assert.equal(sha256(bytes), expected, `Installed Vitest implementation changed: ${path}`);
    return { path, ...identity(bytes), contents: bytes };
  });
  assert.equal(JSON.parse(sources[0].contents).version, VITEST_VERSION);
  const configBytes = readRegular(join(root, 'vitest.config.ts'));
  assert.equal(sha256(configBytes), CONFIG_SHA256,
    'Repository Vitest config changed; re-audit project/cache settings before running');
  return { sources, configBytes };
}
function dependencyEntries(sharedNodeModules) {
  return readdirSync(sharedNodeModules).sort().filter(name =>
    !name.startsWith('.') || name === '.bin' || name === '.package-lock.json');
}
function validateLinks(paths, sharedNodeModules, names, create) {
  for (const name of names) {
    assert(name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\'));
    const destination = join(paths.nodeModules, name), target = join(sharedNodeModules, name);
    const existing = maybeStat(destination);
    if (!existing && create) symlinkSync(target, destination, statSync(target).isDirectory() ? 'dir' : 'file');
    else assert(existing?.isSymbolicLink(), `Dependency overlay entry must be a symlink: ${destination}`);
    assert.equal(realpathSync(destination), realpathSync(target), `Dependency overlay target differs: ${name}`);
  }
}
function snapshot(path, destination) {
  const info = maybeStat(path);
  if (!info) return { state: 'absent', sourcePath: path };
  directoryWithoutLinks(dirname(path));
  const bytes = readRegular(path);
  writeExclusive(destination, bytes);
  return { state: 'present', sourcePath: path, retainedPath: destination,
    ...identity(bytes), mtimeMs: info.mtimeMs };
}

/** Prepare each arm once, after making its real node_modules directory.
 * The shared results file is only read. Existing arm results are never replaced.
 * All earlier test commands, including retries, require another fresh arm/receipt.
 */
export function prepareCache(root, sharedNodeModules, receiptDirectory) {
  const paths = armPaths(root);
  sharedNodeModules = realDirectory(sharedNodeModules, 'Shared node_modules');
  assert(!inside(paths.nodeModules, sharedNodeModules) && !inside(sharedNodeModules, paths.nodeModules),
    'Arm and shared dependency directories must be disjoint');
  receiptDirectory = resolve(receiptDirectory);
  assert(!inside(receiptDirectory, sharedNodeModules), 'Evidence must not write inside shared dependencies');
  assert(!inside(receiptDirectory, paths.nodeModules), 'Evidence must not be inside arm dependencies');
  assert(!maybeStat(receiptDirectory), 'Use a fresh receipt directory; existing evidence cannot be overwritten');
  const implementation = inspectImplementation(sharedNodeModules, paths.root);
  // Check every existing cache ancestor before creating anything in that subtree.
  for (const path of [join(paths.nodeModules, '.vite'), join(paths.nodeModules, '.vite', 'vitest'), paths.cacheDirectory]) {
    if (maybeStat(path)) directoryWithoutLinks(path);
  }
  assert(!maybeStat(paths.resultsPath), 'Arm already has results; use a fresh task-owned arm');
  const names = dependencyEntries(sharedNodeModules);
  const unexpected = readdirSync(paths.nodeModules).filter(name => name !== '.vite' && !names.includes(name));
  assert.equal(unexpected.length, 0, `Unexpected dependency overlay entries: ${unexpected.join(', ')}`);
  validateLinks(paths, sharedNodeModules, names, true);
  directoryWithoutLinks(receiptDirectory, true);
  const sharedResultsPath = join(sharedNodeModules, '.vite', 'vitest', PROJECT_CACHE_KEY, 'results.json');
  const sharedBefore = snapshot(sharedResultsPath, join(receiptDirectory, 'shared-results-before.json'));
  const sources = implementation.sources.map(({ path, contents, ...rest }) => {
    writeExclusive(join(receiptDirectory, 'installed-source', path), contents);
    return { path, ...rest };
  });
  writeExclusive(join(receiptDirectory, 'repository-vitest.config.ts'), implementation.configBytes);
  writeExclusive(join(receiptDirectory, 'fresh-results.json'), seed);
  writeExclusive(paths.resultsPath, seed);
  assert(readRegular(paths.resultsPath).equals(seed));
  const receipt = { schema: CACHE_SCHEMA, preparedAt: new Date().toISOString(), ...paths,
    receiptDirectory, sharedNodeModules, sharedBefore, version: VITEST_VERSION,
    projectName: '', projectCacheKey: PROJECT_CACHE_KEY, seed: identity(seed),
    repositoryConfig: { path: join(paths.root, 'vitest.config.ts'), ...identity(implementation.configBytes) },
    implementation: sources, dependencyLinks: names,
    helper: { path: fileURLToPath(import.meta.url), ...identity(readFileSync(fileURLToPath(import.meta.url))) },
    policy: 'Fresh task-generated empty results, per arm; shared cache read only; test config and command unchanged' };
  writeJson(join(receiptDirectory, 'prepare.json'), receipt);
  verifyCacheStart(paths.root, receipt);
  return receipt;
}

/** Read-only guard. Call immediately before the ordinary, unmodified test command. */
export function verifyCacheStart(root, receipt) {
  const paths = armPaths(root);
  assert.equal(receipt.schema, CACHE_SCHEMA);
  assert.equal(receipt.root, paths.root);
  assert.equal(receipt.nodeModules, paths.nodeModules);
  assert.equal(receipt.resultsPath, paths.resultsPath);
  assert.equal(receipt.cacheDirectory, paths.cacheDirectory);
  assert.equal(receipt.version, VITEST_VERSION);
  assert.equal(receipt.projectName, '');
  assert.equal(receipt.projectCacheKey, PROJECT_CACHE_KEY);
  assert.deepEqual(receipt.seed, identity(seed));
  directoryWithoutLinks(paths.cacheDirectory);
  const shared = realDirectory(receipt.sharedNodeModules, 'Shared node_modules');
  assert(!inside(paths.nodeModules, shared) && !inside(shared, paths.nodeModules));
  assert.deepEqual(receipt.dependencyLinks, dependencyEntries(shared));
  validateLinks(paths, shared, receipt.dependencyLinks, false);
  inspectImplementation(shared, paths.root);
  const bytes = readRegular(paths.resultsPath);
  assert(bytes.equals(seed), 'Cache no longer has the exact fresh bytes; do not run this arm');
  return { verified: true, root: paths.root, resultsPath: paths.resultsPath, ...identity(bytes) };
}

/** Retain result bytes (or absence) after success, failure or timeout; never reset. */
export function archiveCacheEnd(root, receiptDirectory) {
  const paths = armPaths(root);
  receiptDirectory = directoryWithoutLinks(receiptDirectory);
  const receipt = JSON.parse(readRegular(join(receiptDirectory, 'prepare.json')));
  assert.equal(receipt.schema, CACHE_SCHEMA);
  assert.equal(receipt.root, paths.root);
  assert.equal(receipt.resultsPath, paths.resultsPath);
  assert.equal(receipt.receiptDirectory, receiptDirectory);
  assert(!inside(receiptDirectory, realpathSync(receipt.sharedNodeModules)));
  directoryWithoutLinks(paths.cacheDirectory);
  const output = snapshot(paths.resultsPath, join(receiptDirectory, 'results-after.json'));
  const end = { schema: CACHE_SCHEMA, archivedAt: new Date().toISOString(), root: paths.root, output };
  if (output.state === 'present') {
    try {
      const parsed = JSON.parse(readRegular(output.retainedPath));
      end.parsed = { version: parsed.version, resultCount: Array.isArray(parsed.results) ? parsed.results.length : null,
        failedKeys: Array.isArray(parsed.results) ? parsed.results.filter(row => row?.[1]?.failed).map(row => row[0]) : null };
    } catch (error) { end.parseError = String(error); }
  }
  writeJson(join(receiptDirectory, 'end.json'), end);
  return end;
}
