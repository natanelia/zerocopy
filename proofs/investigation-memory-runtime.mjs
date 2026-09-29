/** Stage exact built modules and unchanged website adapters, without a web server. */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export function stageRuntime(root, destination) {
  mkdirSync(destination,{recursive:true}); writeFileSync(join(destination,'package.json'),' {"type":"module"}\n');
  for (const folder of ['assets','library','vendor']) mkdirSync(join(destination,folder));
  for (const name of ['explorer-core.mjs','explorer-storage.mjs','immutable-storage.mjs','explorer-reference.mjs']) cpSync(join(root,'website/assets',name),join(destination,'assets',name));
  for (const name of readdirSync(join(root,'dist')).filter(name=>name.endsWith('.js'))) cpSync(join(root,'dist',name),join(destination,'library',name));
  const pinned=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).devDependencies.immutable;
  if (process.env.MEMORY_VENDOR) {
    // For offline verification only: use the pinned vendor files from a tested site artifact.
    const folder=process.env.MEMORY_VENDOR;
    assert.equal(readFileSync(join(folder,'version.mjs'),'utf8').trim(),`export const immutableVersion = "${pinned}";`);
    cpSync(join(folder,'immutable.mjs'),join(destination,'vendor/immutable.mjs'));
  } else {
    assert.equal(JSON.parse(readFileSync(join(root,'node_modules/immutable/package.json'),'utf8')).version,pinned);
    cpSync(join(root,'node_modules/immutable/dist/immutable.es.js'),join(destination,'vendor/immutable.mjs'));
  }
  const hashes={};
  for (const folder of ['assets','library','vendor']) for (const file of readdirSync(join(destination,folder)).sort())
    hashes[`${folder}/${file}`]=createHash('sha256').update(readFileSync(join(destination,folder,file))).digest('hex');
  assert.ok(existsSync(join(destination,'library/shared.js')));
  return {immutable:pinned,hashes};
}
