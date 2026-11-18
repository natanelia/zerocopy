// Validate two separate archived studies without collecting replacement timings.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const folder = dirname(fileURLToPath(import.meta.url));
const records = [{ name: 'confirmation.json.gz', mode: 'formal' }, { name: 'aa.json.gz', mode: 'aa' }];
const manifest = JSON.parse(readFileSync(join(folder, 'results/manifest.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.deepEqual(Object.keys(manifest).sort(), records.map(record => record.name).sort());
let processes = 0, batches = 0, measuredOutputs = 0, verifiedOutputs = 0;
for (const { name, mode } of records) {
  const filename = join(folder, 'results', name), stored = readFileSync(filename), raw = gunzipSync(stored);
  const record = manifest[name], data = JSON.parse(raw.toString('utf8'));
  assert.equal(stored.length, record.compressedBytes); assert.equal(raw.length, record.uncompressedBytes);
  assert.equal(sha(stored), record.sha256); assert.equal(sha(raw), record.uncompressedSha256);
  assert.equal(data.mode, mode); assert.equal(data.study.id, 'map-foreach-early-identity-20261108');
  const audit = JSON.parse(execFileSync(process.execPath, [join(folder, 'audit-evidence.mjs'), filename],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env } }));
  assert.equal(audit.status, 'independently verified'); assert.equal(audit.mode, mode);
  processes += audit.processes; batches += audit.measuredBatches;
  measuredOutputs += audit.measuredOutputCount; verifiedOutputs += audit.verifiedOutputCount;
  console.log(`${mode}: ${audit.processes} fresh processes; ${audit.measuredBatches} measured batches; exact raw hashes, both source snapshots, unchanged WASM, full schedule, worker identities and paired estimates verified${audit.currentSourcesChecked ? '; both current source hashes matched' : ''}`);
}
console.log(`Verified two separate studies: ${processes} processes, ${batches} measured batches, ${measuredOutputs} measured outputs and ${verifiedOutputs} warmup-plus-measured outputs. No samples removed, adjusted, pooled or retimed.`);
