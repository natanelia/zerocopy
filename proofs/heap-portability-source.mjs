import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONTEXT } from './heap-portability-protocol.mjs';
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
export function sourceReceipt(root, role, builds = false) {
  root = resolve(root); assert.equal(realpathSync(root), root); assert(!lstatSync(root).isSymbolicLink());
  const pins = json(new URL('./heap-portability-pins.json', import.meta.url)), commit = CONTEXT[role];
  assert.equal(git(root, ['rev-parse', 'HEAD']).toString().trim(), commit);
  assert.equal(git(root, ['rev-parse', 'HEAD^{tree}']).toString().trim(), pins.trees[role]);
  assert.equal(git(root, ['diff', '--name-only', 'HEAD']).toString().trim(), '', 'Tracked inputs changed');
  const files = {};
  for (const file of git(root, ['ls-tree', '-r', '--name-only', commit]).toString().trim().split('\n')) {
    const path = join(root, file); assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
    files[file] = sha256(readFileSync(path)); assert.equal(files[file], sha256(git(root, ['show', `${commit}:${file}`])));
  }
  assert.deepEqual(files, pins.sources[role], 'Source differs from exact frozen commit');
  const receipt = { root, commit, tree: pins.trees[role], files, production: pins.production[role] };
  if (builds) {
    receipt.bundle = manifest(join(root, 'dist'));
    assert.deepEqual(receipt.bundle, pins.bundles[role], 'Complete portable bundle differs from original measured bytes');
    receipt.wasm = Object.fromEntries(readdirSync(root).filter(file => file.endsWith('.wasm')).sort().map(file => [file, sha256(readFileSync(join(root, file)))]));
    assert.deepEqual(receipt.wasm, pins.wasm[role]);
    receipt.compilers = {};
    for (const name of ['assemblyscript', 'typescript', 'bun-types', 'playwright', 'playwright-core']) {
      const dir = join(root, 'node_modules', name), bytes = readFileSync(join(dir, 'package.json'));
      receipt.compilers[name] = { version: JSON.parse(bytes).version, packageSha256: sha256(bytes), files: manifest(realpathSync(dir)) };
    }
    const packagePins = json(join(root, 'package.json')).devDependencies;
    for (const name of ['assemblyscript', 'typescript', 'bun-types', 'playwright']) assert.equal(receipt.compilers[name].version, packagePins[name]);
    assert.equal(receipt.compilers['playwright-core'].version, '1.63.0');
  }
  return receipt;
}
export function verifyPair(baseline, candidate, builds = true) {
  const receipts = { baseline: sourceReceipt(baseline, 'baseline', builds), candidate: sourceReceipt(candidate, 'candidate', builds) };
  assert.deepEqual(Object.keys(receipts.baseline.production), Object.keys(receipts.candidate.production));
  assert.deepEqual(Object.keys(receipts.baseline.production).filter(file => receipts.baseline.production[file] !== receipts.candidate.production[file]), ['shared-priority-queue.ts']);
  if (builds) { assert.deepEqual(receipts.baseline.wasm, receipts.candidate.wasm); assert.deepEqual(receipts.baseline.compilers, receipts.candidate.compilers); }
  return receipts;
}
