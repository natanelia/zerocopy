/** Exact portable import closure, not an npm release package. No timings. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function inventory(root) {
  function walk(dir) {
    return readdirSync(dir).sort().flatMap(name => {
      const file = join(dir, name), stat = lstatSync(file);
      assert(!stat.isSymbolicLink(), `Runtime symlink: ${file}`);
      if (stat.isDirectory()) return walk(file);
      assert(stat.isFile());
      const data = readFileSync(file);
      return [{ file: relative(root, file), bytes: data.length, sha256: hash(data) }];
    });
  }
  return walk(root);
}
export function closure(root) {
  const files = new Set();
  function visit(name) {
    assert.match(name, /^(?:shared|chunk-[a-z0-9]+)\.js$/);
    if (files.has(name)) return;
    files.add(name);
    const source = readFileSync(join(root, name), 'utf8');
    assert.doesNotMatch(source, /\bimport\s*\(/, 'No unaccounted dynamic imports');
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g)];
    for (const match of imports) {
      assert.match(match[1], /^\.\/(?:shared|chunk-[a-z0-9]+)\.js$/);
      visit(match[1].slice(2));
    }
  }
  visit('shared.js');
  return [...files].sort();
}
export function stage(source, destination) {
  mkdirSync(destination); // Existing output is never silently replaced.
  writeFileSync(join(destination, 'package.json'), '{"private":true,"type":"module"}\n');
  for (const file of closure(source)) copyFileSync(join(source, file), join(destination, file));
  const files = inventory(destination);
  assert.deepEqual(files.map(x => x.file), [...closure(destination), 'package.json'].sort());
  return { files, reachableJsBytes: files.filter(x => x.file.endsWith('.js')).reduce((n, x) => n + x.bytes, 0),
    perFileGzipBytes: files.filter(x => x.file.endsWith('.js')).reduce((n, x) => n + gzipSync(readFileSync(join(destination, x.file))).length, 0) };
}
export function verifyManifest(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(readdirSync(join(root, 'runtime')).sort(), ['A0', 'A1', 'B0', 'B1', 'C0', 'C1']);
  for (const arm of ['A0', 'A1', 'B0', 'B1', 'C0', 'C1']) {
    assert.deepEqual(inventory(join(root, 'runtime', arm)), manifest.arms[arm].files, arm);
    assert.deepEqual(manifest.arms[arm].files.map(x => x.file), [...closure(join(root, 'runtime', arm)), 'package.json'].sort());
  }
  for (const arm of ['A', 'B', 'C']) assert.deepEqual(manifest.arms[arm + '0'], manifest.arms[arm + '1'], 'A/A bytes must match');
  return manifest;
}
