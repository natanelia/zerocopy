/** Independent workload/comparison processes, copied-bundle A/A, balanced imports. */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const baseline = resolve(process.argv[2]), candidate = resolve(process.argv[3]), out = resolve(process.argv[4]);
mkdirSync(out, { recursive: true }); const control = resolve(out, '.baseline-control');
for (const path of ['arena.ts', 'codec.ts', 'freeze-json.ts', 'persistent-core.as.ts', 'shared-list.ts', 'package.json', 'scripts/build-wasm.mjs', 'scripts/build-browser.ts', 'persistent-core.wasm', 'dist']) {
  mkdirSync(dirname(resolve(control, path)), { recursive: true }); cpSync(resolve(baseline, path), resolve(control, path), { recursive: true });
}
const harness = fileURLToPath(new URL('./core-link-range-case.mjs', import.meta.url)), rounds = Number(process.env.ROUNDS ?? 4), runtimes = (process.env.RUNTIMES ?? 'node,bun').split(',');
const cases = ['append-empty', 'append-tail-only', 'append-existing-1k', 'append-existing-8k', 'set-control'], rows = [];
for (let round = 0; round < rounds; round++) for (const runtime of round % 2 ? [...runtimes].reverse() : runtimes) {
  for (let i = 0; i < cases.length; i++) for (const comparison of round % 2 ? ['AA', 'AB'] : ['AB', 'AA']) {
    const name = cases[(i + round) % cases.length], importOrder = round % 2 ? 'candidate-first' : 'baseline-first';
    const raw = execFileSync(runtime === 'node' ? process.execPath : process.env.BUN ?? 'bun', [...(runtime === 'node' ? ['--expose-gc'] : []), harness, baseline, comparison === 'AA' ? control : candidate, name],
      { encoding: 'utf8', env: { ...process.env, COMPARISON: comparison, IMPORT_ORDER: importOrder }, maxBuffer: 8 * 1024 * 1024 });
    const result = JSON.parse(raw); writeFileSync(resolve(out, `${runtime}-${comparison}-${name}-${round + 1}.json`), raw);
    rows.push({ round: round + 1, runtime, comparison, importOrder, name, baselineOverCandidate: result.baselineOverCandidate, mediansMs: result.mediansMs });
    console.log(runtime, round + 1, comparison, importOrder, name, result.baselineOverCandidate.toFixed(3));
  }
}
writeFileSync(resolve(out, 'summary.json'), JSON.stringify({ rounds, rows, note: 'Independent case/comparison processes with copied-bundle A/A. Four default rounds balance import order. Ratios below 1 mean slower second implementation. No timing CI gate.' }, null, 2));
