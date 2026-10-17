import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

// Copy only the installed AssemblyScript compiler and its production
// dependencies. Do not install, update, execute or republish any package.
const project = resolve(process.env.CANDIDATE_DIR ?? '.');
const output = resolve(process.env.TOOLKIT_DIR ?? 'proofs/results/numeric-tree-hosted/compiler-toolkit');
assert.ok(!existsSync(output), 'Refuse to overwrite a compiler snapshot');
const rootPackage = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
const compiler = realpathSync(join(project, 'node_modules/assemblyscript'));
assert.equal(JSON.parse(readFileSync(join(compiler, 'package.json'), 'utf8')).version, rootPackage.devDependencies.assemblyscript, 'Installed compiler differs from the pinned version');
mkdirSync(join(output, 'node_modules'), { recursive: true });
const copied = new Map();
function packageRoot(entry, name) {
  let dir = dirname(entry);
  for (;;) {
    const p = join(dir, 'package.json');
    if (existsSync(p) && JSON.parse(readFileSync(p, 'utf8')).name === name) return realpathSync(dir);
    const parent = dirname(dir); assert.notEqual(parent, dir, `Cannot locate installed package ${name}`); dir = parent;
  }
}
function copyPackage(source) {
  const p = join(source, 'package.json'); const pkg = JSON.parse(readFileSync(p, 'utf8'));
  assert.match(pkg.name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i);
  if (copied.has(pkg.name)) { assert.equal(copied.get(pkg.name).version, pkg.version, 'Conflicting dependency versions'); return; }
  copied.set(pkg.name, { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies ?? {} });
  const destination = join(output, 'node_modules', pkg.name);
  cpSync(source, destination, { recursive: true, dereference: true, filter: path => path === source || path.split(/[\\/]/).at(-1) !== 'node_modules' });
  const require = createRequire(p);
  for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
    let entry;
    try { entry = require.resolve(`${name}/package.json`); }
    catch { entry = require.resolve(name); }
    copyPackage(packageRoot(entry, name));
  }
}
copyPackage(compiler);
const files = {};
function walk(dir, prefix) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = join(dir, entry.name); const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) walk(path, `${relative}/`);
    else { const bytes = readFileSync(path); files[relative] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
  }
}
walk(join(output, 'node_modules'), 'node_modules/');
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ compiler: rootPackage.devDependencies.assemblyscript, packages: [...copied.values()], files }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ packages: [...copied.values()], files: Object.keys(files).length }));
