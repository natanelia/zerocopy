/** One fresh process per operation and runtime; preserve every raw round. */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const baseline = resolve(process.argv[2]), candidate = resolve(process.argv[3]), out = resolve(process.argv[4]);
mkdirSync(out, { recursive: true });
const harness = fileURLToPath(new URL('./bulk-leaf-performance.mjs', import.meta.url));
const control = resolve(out, '.baseline-control');
for (const path of ['arena.ts', 'codec.ts', 'freeze-json.ts', 'persistent-core.as.ts', 'shared-map.ts', 'package.json', 'scripts/build-wasm.mjs', 'scripts/build-browser.ts', 'persistent-core.wasm', 'dist']) {
  mkdirSync(dirname(resolve(control, path)), { recursive: true }); cpSync(resolve(baseline, path), resolve(control, path), { recursive: true });
}
const rounds = Number(process.env.ROUNDS ?? 4), runtimes = (process.env.RUNTIMES ?? 'node,bun').split(',');
const rows = [];
for (let round = 0; round < rounds; round++) for (const runtime of round % 2 ? [...runtimes].reverse() : runtimes) {
  const cases = ['number:saving', 'number:control', 'number:mixed', 'boolean:saving', 'boolean:control', 'boolean:mixed'];
  for (let i = 0; i < cases.length; i++) {
    const [type, mode] = cases[(i + round) % cases.length].split(':');
    for (const comparison of round % 2 ? ['AA', 'AB'] : ['AB', 'AA']) {
      const importOrder = round % 2 ? 'candidate-first' : 'baseline-first';
      const args = [...(runtime === 'node' ? ['--expose-gc'] : []), harness, baseline, comparison === 'AA' ? control : candidate, type, mode];
      const raw = execFileSync(runtime === 'node' ? process.execPath : process.env.BUN ?? 'bun', args, { encoding: 'utf8', env: { ...process.env, COMPARISON: comparison, IMPORT_ORDER: importOrder }, maxBuffer: 8 * 1024 * 1024 });
      const result = JSON.parse(raw); writeFileSync(resolve(out, `${runtime}-${comparison}-${type}-${mode}-${round + 1}.json`), raw);
      rows.push({ round: round + 1, runtime, comparison, importOrder, type, mode, baselineOverCandidate: result.baselineOverCandidate, mediansMs: result.mediansMs });
      console.log(runtime, round + 1, comparison, importOrder, type, mode, result.baselineOverCandidate.toFixed(3));
    }
  }
}
writeFileSync(resolve(out, 'summary.json'), JSON.stringify({ rounds, rows, note: 'One fresh process per workload, comparison and runtime. A/A uses independent identical baseline copies. Four default rounds balance import order. Ratios below 1 mean slower second implementation; no wall-clock CI gate.' }, null, 2));
