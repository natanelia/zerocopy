// node run.mjs codec|reader NEW_OUTPUT.json [pairs=7]
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeFixture } from '../shared-bytes-20261113/fixtures.mjs';

const [mode, output, pairArg = '7'] = process.argv.slice(2), pairs = Number(pairArg);
if (!['codec', 'reader'].includes(mode) || !output || existsSync(output) || !Number.isSafeInteger(pairs) || pairs < 1) {
  throw Error('Expected codec|reader NEW_OUTPUT.json [pairs=7]');
}
const sha = file => createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex');
const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceNames = ['run.mjs', 'bench-worker.mjs', 'direct-json-guarded.mjs',
  '../shared-bytes-20261113/direct-json.mjs', '../shared-bytes-20261113/fixtures.mjs',
  '../shared-bytes-20261113/.runtime/utf8.mjs', '../shared-bytes-20261113/.runtime/freeze-json.mjs',
  '../../website/assets/catalog-core.mjs', '../../website/assets/catalog-reference.mjs',
  '../../proofs/reader-startup-20261112/worker.mjs'];
const data = {
  schema: 'zerocopy-utf8-followup/v1', baseline: 'b4c08def84b905026632bfd27612da4efef0a3f0',
  mode, pairs, node: process.version, v8: process.versions.v8, platform: process.platform,
  arch: process.arch, cpu: cpus()[0]?.model, startedAt: new Date().toISOString(),
  sources: Object.fromEntries(sourceNames.map(file => [file, sha(file)])),
  method: mode === 'codec'
    ? 'Fresh worker per arm/sample; no parser warmup. Shared fixture creation and worker/module startup excluded. All complete frozen outputs retained during timing, full content/freeze checks afterward. Native-a/native-b use identical code as a noise control. Four arms rotate by pair. All samples retained.'
    : 'Unchanged PR #75 catalog workload at 10k: two fresh readers, 1000 requested IDs and 910 hits, full-field fingerprints. Fresh process per arm/sample; no reader warmup; module/worker startup excluded. Native-a/native-b use identical builds as noise control. Three arms rotate by pair. Guarded changes only object materialization. All samples retained.',
  rows: [],
};
const save = () => { writeFileSync(output + '.partial', JSON.stringify(data, null, 2) + '\n'); renameSync(output + '.partial', output); };
const runFile = promisify(execFile);
function sample(fixture, method) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bench-worker.mjs', import.meta.url));
    const timeout = setTimeout(() => { worker.terminate(); reject(Error('Worker timeout')); }, 60000);
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.on('message', async message => {
      if (message.ready) { worker.postMessage({ fixture, method }); return; }
      clearTimeout(timeout); await worker.terminate();
      message.error ? reject(Error(message.error)) : resolve(message.result);
    });
  });
}
save();
try {
  if (mode === 'codec') {
    const methods = ['native-a', 'native-b', 'original', 'guarded'];
    for (const kind of ['catalog', 'unicode', 'numeric', 'large-early', 'large-late']) {
      const count = kind === 'numeric' ? 2000 : 10000, fixture = makeFixture(kind, count);
      for (let pair = 0; pair < pairs; pair++) {
        for (let offset = 0; offset < methods.length; offset++) {
          const method = methods[(pair + offset) % methods.length];
          data.rows.push({ kind, count, pair, method, ...await sample(fixture, method) }); save();
        }
      }
      console.log(`${kind}: ${data.rows.length} verified samples`);
    }
  } else {
    data.buildManifest = JSON.parse(readFileSync(new URL('.runtime/build-manifest.json', import.meta.url), 'utf8'));
    const methods = ['native-a', 'native-b', 'guarded'];
    for (let pair = 0; pair < pairs; pair++) {
      for (let offset = 0; offset < methods.length; offset++) {
        const method = methods[(pair + offset) % methods.length];
        const variant = method === 'guarded' ? 'guarded' : 'native';
        const variantRoot = fileURLToPath(new URL(`.runtime/${variant}/`, import.meta.url));
        const child = await runFile(process.execPath, [`${root}proofs/reader-startup-20261112/worker.mjs`, variantRoot, 'catalog-map', '10000'],
          { timeout: 120000, maxBuffer: 1024 * 1024 });
        const result = JSON.parse(child.stdout);
        if (result.verified !== true) throw Error('Unverified reader sample');
        data.rows.push({ kind: 'catalog', count: 10000, pair, method, ...result }); save();
        console.log(`pair ${pair} ${method}: first query ${result.times.firstQueryMs.toFixed(3)} ms`);
      }
    }
  }
  data.completedAt = new Date().toISOString(); save();
} catch (error) { data.error = error.stack; save(); throw error; }

