/** Copy the exact portable runtime and website adapters; never build a candidate. */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function stageRuntime(root, destination) {
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'package.json'), '{"type":"module"}\n');
  for (const folder of ['assets', 'library', 'vendor']) mkdirSync(join(destination, folder));
  for (const name of ['feature-core.mjs', 'feature-storage.mjs', 'feature-reference.mjs']) cpSync(join(root, 'website/assets', name), join(destination, 'assets', name));
  for (const name of readdirSync(join(root, 'dist')).filter(name => name.endsWith('.js'))) cpSync(join(root, 'dist', name), join(destination, 'library', name));
  const pinned = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies;
  const dependencies = { immutable: pinned.immutable, immer: pinned.immer };
  const versionText = `export const immutableVersion = ${JSON.stringify(dependencies.immutable)};\nexport const immerVersion = ${JSON.stringify(dependencies.immer)};\n`;
  if (process.env.FEATURE_MEMORY_VENDOR) {
    // Optional offline artifact: the exact version marker and module hashes are retained.
    const source = process.env.FEATURE_MEMORY_VENDOR;
    assert.equal(readFileSync(join(source, 'version.mjs'), 'utf8').trim(), versionText.trim(), 'Vendor versions do not match pinned dependencies');
    for (const name of ['immutable.mjs', 'immer.mjs']) cpSync(join(source, name), join(destination, 'vendor', name));
  } else {
    for (const name of Object.keys(dependencies)) assert.equal(JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version, dependencies[name], `Install pinned ${name}`);
    cpSync(join(root, 'node_modules/immutable/dist/immutable.es.js'), join(destination, 'vendor/immutable.mjs'));
    cpSync(join(root, 'node_modules/immer/dist/immer.production.mjs'), join(destination, 'vendor/immer.mjs'));
  }
  writeFileSync(join(destination, 'vendor/version.mjs'), versionText);
  assert.ok(existsSync(join(destination, 'library/shared.js')), 'Portable dist is missing');
  const hashes = {};
  for (const folder of ['assets', 'library', 'vendor']) for (const name of readdirSync(join(destination, folder)).sort()) hashes[`${folder}/${name}`] = sha256(readFileSync(join(destination, folder, name)));
  return { dependencies, hashes };
}
