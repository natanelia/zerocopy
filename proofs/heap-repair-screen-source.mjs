import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONTEXT } from './heap-repair-screen-protocol.mjs';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path + '.pending', JSON.stringify(value, null, 2) + '\n'); renameSync(path + '.pending', path); };
export function manifest(root) {
  const entries = {};
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name); assert(!entry.isSymbolicLink(), `Symlink in archive: ${path}`);
      if (entry.isDirectory()) visit(path); else { assert(entry.isFile()); entries[relative(root, path)] = sha256(readFileSync(path)); }
    }
  }
  visit(root); return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}
const git = (root, args) => execFileSync('git', args, { cwd: root, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
export function compilerManifest(root) {
 const result = {};
 for (const name of ['assemblyscript', 'typescript', 'bun-types', 'playwright', 'playwright-core', 'vitest']) {
  const dir = realpathSync(join(root, 'node_modules', name)), bytes = readFileSync(join(dir, 'package.json'));
  result[name] = { version: JSON.parse(bytes).version, packageSha256: sha256(bytes), files: manifest(dir) };
 }
 const pins = json(join(root, 'package.json')).devDependencies;
 for (const name of ['assemblyscript', 'typescript', 'bun-types', 'playwright', 'vitest']) assert.equal(result[name].version, pins[name]);
 assert.equal(result['playwright-core'].version, '1.63.0'); return result;
}
export function sourceReceipt(root, role, builds = false) {
 root = resolve(root); assert.equal(realpathSync(root), root); assert(!lstatSync(root).isSymbolicLink());
 const pins = json(new URL('./heap-repair-screen-pins.json', import.meta.url))[role]; assert(pins);
 assert.equal(pins.commit, CONTEXT[role]); assert.equal(git(root, ['rev-parse', 'HEAD']).toString().trim(), pins.commit);
 assert.equal(git(root, ['rev-parse', 'HEAD^{tree}']).toString().trim(), pins.tree);
 assert.equal(git(root, ['diff', '--name-only', 'HEAD']).toString().trim(), '', 'Tracked inputs changed');
 const names = git(root, ['ls-tree', '-r', '--name-only', pins.commit]).toString().trim().split('\n');
 assert.deepEqual(names.sort(), Object.keys(pins.source).sort());
 const files = {};
 for (const file of names) { const path = join(root, file); assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()); files[file] = sha256(readFileSync(path)); assert.equal(files[file], pins.source[file], file); }
 const allowed = new Set([...names, 'geometry-kernels.wat', 'numeric-kernels.wat', 'persistent-core.wat', 'bun.lock', 'bun.lockb']);
 for (const name of readdirSync(root)) if (/\.(?:ts|mjs|cjs|js|json|wasm)$/.test(name)) assert(allowed.has(name) || name.endsWith('.wasm') && Object.hasOwn(pins.wasm, name), `Unpinned root input ${name}`);
 for (const dir of ['scripts', 'type-tests']) assert.deepEqual(Object.keys(manifest(join(root, dir))).sort(), names.filter(file => file.startsWith(dir + '/')).map(file => file.slice(dir.length + 1)).sort());
 const receipt = { root, commit: pins.commit, tree: pins.tree, files, runtimeSourceSha256: pins.runtimeSourceSha256, compilers: compilerManifest(root) };
 if (builds) {
  receipt.bundle = manifest(join(root, 'dist')); assert.deepEqual(receipt.bundle, pins.bundles, 'Complete portable build including declarations differs from reviewed bytes');
  receipt.wasm = Object.fromEntries(readdirSync(root).filter(file => file.endsWith('.wasm')).sort().map(file => [file, sha256(readFileSync(join(root, file)))]));
  assert.deepEqual(receipt.wasm, pins.wasm);
 }
 return receipt;
}
export function verifyTriple(roots, builds = true) {
 assert.deepEqual(Object.keys(roots), ['baseline', 'current', 'repair']);
 const receipts = Object.fromEntries(Object.entries(roots).map(([role, root]) => [role, sourceReceipt(root, role, builds)]));
 for (const role of ['current', 'repair']) {
  const production = file => /^(?:[^/]+\.(?:ts|json)|scripts\/|type-tests\/)/.test(file);
  const baseline = Object.keys(receipts.baseline.files).filter(production), other = Object.keys(receipts[role].files).filter(production);
  // Public repair/current include existing heap regression tests absent from the historical baseline.
  const common = baseline.filter(file => other.includes(file));
  assert.deepEqual(common.filter(file => receipts.baseline.files[file] !== receipts[role].files[file]), ['shared-priority-queue.ts']);
  assert.deepEqual(receipts.baseline.compilers, receipts[role].compilers, 'Different toolchain across arms');
  if (builds) assert.deepEqual(receipts.baseline.wasm, receipts[role].wasm);
 }
 assert.deepEqual(Object.keys(receipts.current.files), Object.keys(receipts.repair.files));
 assert.deepEqual(Object.keys(receipts.current.files).filter(file => receipts.current.files[file] !== receipts.repair.files[file]), ['shared-priority-queue.ts']);
 return receipts;
}
