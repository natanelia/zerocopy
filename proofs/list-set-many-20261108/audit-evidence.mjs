import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const folder = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(folder, '../..'));
const resultDirectory = join(folder, 'results');
const records = readdirSync(resultDirectory).filter(name => /\.json(?:\.gz)?$/.test(name)).map(name => {
  const path = join(resultDirectory, name), bytes = readFileSync(path);
  return { path, data: JSON.parse((name.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8')) };
}).filter(({ data }) => data.schema === 'zerocopy-paired-public-operation/v1' && data.status === 'complete');
const formal = records.filter(({ data }) => data.mode === 'formal').sort((a, b) => a.data.startedAt.localeCompare(b.data.startedAt));
assert.ok(formal.length, 'Commit the complete formal record before claiming the batch improvement');
assert.ok(records.some(({ data }) => data.mode === 'aa'), 'Commit the same-build control record');
for (const record of records) {
  const exactCurrent = record === formal.at(-1);
  const result = JSON.parse(execFileSync(process.execPath, [join(folder, 'verify.mjs'), record.path,
    ...(exactCurrent ? [root] : [])], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  console.log(JSON.stringify({ record: record.path, mode: result.mode, processes: result.processes,
    timedBatches: result.timedBatches, verifiedOutputs: result.verifiedOutputs,
    measuredBatchesBelow2ms: result.measuredBatchesBelow2ms, exactCurrentBuild: result.exactCurrentBuild }));
}
