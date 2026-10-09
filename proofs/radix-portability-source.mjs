import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONTEXT } from './radix-portability-protocol.mjs';
import { sha256, BUNDLE_SHA256, WASM_SHA256, bundleManifest, wasmManifest, compilerManifest, isProductionSource, assertCaptureDelta } from './trie-view-source.mjs';
export { sha256 } from './trie-view-source.mjs';
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
export function sourceReceipt(root, role) {
  root = resolve(root); assert.equal(realpathSync(root), root); assert(!lstatSync(root).isSymbolicLink());
  const commit = CONTEXT[role]; assert(commit);
  assert.equal(git(root, ['rev-parse', 'HEAD']).toString().trim(), commit);
  assert.equal(git(root, ['diff', '--name-only', 'HEAD']).toString().trim(), '', 'Tracked inputs changed');
  const names = git(root, ['ls-tree', '-r', '--name-only', commit]).toString().trim().split('\n');
  const files = Object.fromEntries(names.map(file => {
    const path = join(root, file); assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
    const actual = sha256(readFileSync(path)); assert.equal(actual, sha256(git(root, ['show', `${commit}:${file}`])), `Changed input ${file}`);
    return [file, actual];
  }));
  const production = Object.fromEntries(Object.entries(files).filter(([file]) => isProductionSource(file)));
  const pinned = json(new URL('./radix-portability-pins.json', import.meta.url));
  assert.deepEqual(production, pinned.production[role], 'Source changed from reviewed production inputs');
  const actualProtected = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (['bun.lock', 'bun.lockb'].includes(entry.name)) continue; // Generated install receipt, archived separately.
    if (isProductionSource(entry.name)) { assert(entry.isFile() && !entry.isSymbolicLink()); actualProtected.push(entry.name); }
    else if (['scripts', 'type-tests'].includes(entry.name)) {
      assert(entry.isDirectory() && !entry.isSymbolicLink());
      actualProtected.push(...Object.keys(manifest(join(root, entry.name))).map(file => `${entry.name}/${file}`));
    }
  }
  assert.deepEqual(actualProtected.sort(), Object.keys(production).filter(file => !['bun.lock', 'bun.lockb'].includes(file)).sort(), 'Unexpected production/module-resolution input');
  return { root, commit, files, production };
}
export function verifyPair(baseline, candidate, builds = true) {
  const receipts = { baseline: sourceReceipt(baseline, 'baseline'), candidate: sourceReceipt(candidate, 'candidate') };
  assertCaptureDelta(readFileSync(join(baseline, 'arena.ts')), readFileSync(join(candidate, 'arena.ts')));
  assert.deepEqual(Object.keys(receipts.baseline.production), Object.keys(receipts.candidate.production));
  assert.deepEqual(Object.keys(receipts.baseline.production).filter(file => receipts.baseline.production[file] !== receipts.candidate.production[file]), ['arena.ts']);
  if (builds) for (const [role, root] of Object.entries({ baseline, candidate })) {
    receipts[role].wasm = wasmManifest(root); assert.deepEqual(receipts[role].wasm, WASM_SHA256);
    receipts[role].bundle = bundleManifest(join(root, 'dist/shared.js')); assert.deepEqual(receipts[role].bundle, BUNDLE_SHA256[role]);
    receipts[role].compilers = compilerManifest(root);
  }
  return receipts;
}
