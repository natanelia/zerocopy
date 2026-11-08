import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = dirname(fileURLToPath(import.meta.url));
const candidate = resolve(process.argv[2] ?? join(folder, '../..'));
const baseline = process.argv[3] ? resolve(process.argv[3]) : null;
for (const mode of ['pilot', 'formal', 'aa']) {
  const plain = join(folder, 'results', `${mode}.json`), path = existsSync(plain) ? plain : `${plain}.gz`;
  assert.ok(existsSync(path), `Complete and review the ${mode} record before claiming an improvement`);
  const current = mode === 'aa' ? baseline : candidate;
  const verified = JSON.parse(execFileSync(process.execPath, [join(folder, 'verify.mjs'), path, ...(current ? [current] : [])], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }));
  console.log(JSON.stringify({ mode, processes: verified.processes, timedBatches: verified.timedBatches,
    verifiedOutputs: verified.verifiedOutputs, measuredBatchesBelow2ms: verified.measuredBatchesBelow2ms,
    exactCurrentBuild: verified.exactCurrentBuild }));
}
