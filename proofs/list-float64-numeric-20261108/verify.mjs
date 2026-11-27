// Audit the saved evidence; do not collect replacement performance samples.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const folder = dirname(fileURLToPath(import.meta.url));
const names = ['pilot.json.gz', 'confirmation.json.gz', 'aa.json.gz'];
const manifest = JSON.parse(readFileSync(join(folder, 'results/manifest.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.deepEqual(Object.keys(manifest).sort(), [...names].sort());
let processes = 0, batches = 0, verifiedOutputs = 0;
for (const name of names) {
  const filename = join(folder, 'results', name), stored = readFileSync(filename), raw = gunzipSync(stored);
  const record = manifest[name], data = JSON.parse(raw.toString('utf8'));
  assert.equal(stored.length, record.compressedBytes);
  assert.equal(raw.length, record.uncompressedBytes);
  assert.equal(sha(stored), record.sha256);
  assert.equal(sha(raw), record.uncompressedSha256);
  const audit = JSON.parse(execFileSync(process.execPath, [join(folder, 'audit-evidence.mjs'), filename],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env } }));
  assert.equal(audit.status, 'independently verified');
  processes += audit.processes; batches += audit.measuredBatches; verifiedOutputs += audit.verifiedOutputCount;
  console.log(`${data.mode}: ${audit.processes} fresh processes; ${audit.measuredBatches} measured batches; raw hashes, source, loaded module graph, schedule, outputs, worker evidence and paired estimates verified`);
}
console.log(`Verified ${names.length} studies, ${processes} processes, ${batches} measured batches and ${verifiedOutputs} warmup-plus-measured outputs. No samples removed, adjusted or retimed.`);
