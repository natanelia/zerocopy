// First run ../shared-bytes-20261113/prepare.mjs against the exact baseline dist.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('./', import.meta.url));
const baseline = fileURLToPath(new URL('../shared-bytes-20261113/.runtime/before/dist/', import.meta.url));
const output = join(here, '.runtime');
mkdirSync(output, { recursive: true });
for (const name of ['native', 'guarded']) cpSync(baseline, join(output, name, 'dist'), { recursive: true });
const targetDir = join(output, 'guarded', 'dist');
const marker = 'const parsed = JSON.parse(decodeUtf8(decoder2, this.bytes.subarray(ptr, ptr + len)));\n    const nested = parseNestedType(type);';
const targets = readdirSync(targetDir).filter(name => name.endsWith('.js') && readFileSync(join(targetDir, name), 'utf8').includes(marker));
if (targets.length !== 1) throw Error('Expected exactly one baseline Arena.decodeAt marker');
const file = join(targetDir, targets[0]), input = readFileSync(file, 'utf8');
if (input.split('result = freezeJSON(parsed);').length !== 2) throw Error('Expected exactly one freeze marker');
const patched = input.replace(marker,
  'const nested = parseNestedType(type);\n    const parsed = nested ? JSON.parse(decodeUtf8(decoder2, this.bytes.subarray(ptr, ptr + len))) : parseUtf8JSON(this.bytes.subarray(ptr, ptr + len));')
  .replace('result = freezeJSON(parsed);', 'result = parsed;');
writeFileSync(file, 'import { parseUtf8JSON } from "./_direct-json-guarded.mjs";\n' + patched);
cpSync(join(here, 'direct-json-guarded.mjs'), join(targetDir, '_direct-json-guarded.mjs'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const manifest = {
  baseline: 'b4c08def84b905026632bfd27612da4efef0a3f0',
  patch: 'Only object materialization in Arena.decodeAt; address/key caches, nested codecs, writers, traversal and transport unchanged.',
  native: {}, guarded: {},
};
for (const arm of ['native', 'guarded']) for (const name of readdirSync(join(output, arm, 'dist')).filter(name => /\.(m?js)$/.test(name))) {
  manifest[arm][name] = sha(join(output, arm, 'dist', name));
}
writeFileSync(join(output, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared baseline and guarded materializer (${targets[0]}).`);
