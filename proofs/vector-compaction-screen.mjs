/** Exploratory paired screen. Final claims need independent-process evidence. */
import { performance } from 'node:perf_hooks';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { cases, createCase } from './vector-compaction-cases.mjs';

const root = resolve(import.meta.dirname, '..');
const roots = [resolve(process.env.BASE_DIR ?? '../zerocopy'), resolve(process.env.CANDIDATE_DIR ?? root)];
const apis = await Promise.all(roots.map(dir => import(pathToFileURL(resolve(dir, 'dist/shared.js')).href)));
const runtimes = { node: process.version, bun: process.versions.bun ?? null, v8: process.versions.v8 ?? null, arch: process.arch, cpu: cpus()[0]?.model };
const hash = content => createHash('sha256').update(content).digest('hex');
const manifest = dir => ({ compaction: hash(readFileSync(resolve(dir, 'compaction.ts'))), modules: Object.fromEntries(readdirSync(resolve(dir, 'dist')).filter(name => name.endsWith('.js')).sort().map(name => [name, hash(readFileSync(resolve(dir, 'dist', name)))])) });
const gc = () => { if (typeof Bun !== 'undefined') Bun.gc(true); else globalThis.gc?.(); };
const median = samples => [...samples].sort((a, b) => a - b)[samples.length >> 1];
const selected = process.env.CASE ? cases.filter(spec => spec.name === process.env.CASE) : cases;
if (!selected.length) throw new Error('Unknown CASE');
const rows = [];
const stage = process.env.STAGE ?? 'stage-1', runtime = process.versions.bun ? 'bun' : 'node';
const out = resolve(root, 'proofs/results/vector-compaction', stage);
mkdirSync(out, { recursive: true });
const record = { kind: 'exploratory same-process paired screen', stage, date: new Date().toISOString(), runtimes, sources: roots.map(manifest), complete: false, rows };
const save = () => writeFileSync(resolve(out, `${runtime}.json`), JSON.stringify(record, null, 2) + '\n');
save();
for (const spec of selected) {
  const items = apis.map(api => createCase(api, spec));
  const checks = items.map(item => { item.run(1); return item.check(); });
  if (checks[0].usedBytes !== checks[1].usedBytes || checks[0].backingBytes !== checks[1].backingBytes) throw new Error(`Storage changed for ${spec.name}`);
  const samples = [[], []];
  const iterations = Math.max(1, Math.min(64, Math.floor(262144 / Math.max(32, spec.size))));
  for (let round = -4; round < 9; round++) {
    for (const arm of round % 2 ? [1, 0] : [0, 1]) {
      gc();
      const started = performance.now(); items[arm].run(iterations); const elapsed = performance.now() - started;
      if (round >= 0) samples[arm].push(elapsed);
    }
  }
  const finalChecks = items.map(item => item.check());
  const ms = samples.map(median), speedup = ms[0] / ms[1];
  rows.push({ ...spec, iterations, samples, ms, speedup, finalChecks });
  save();
  console.log(`${spec.name}: ${speedup.toFixed(3)}x (${ms[0].toFixed(3)} -> ${ms[1].toFixed(3)} ms/batch)`);
}
record.complete = true;
save();
