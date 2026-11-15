import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { cpus, platform, release, arch } from 'node:os';
import { runStudy } from './study-core.mjs';

const configuration = JSON.parse(process.argv[2]);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const moduleAt = (root, path) => import(pathToFileURL(resolve(root, path)).href);
const startedAt = new Date().toISOString();
emit({ type: 'process-start', configuration, startedAt, runtime: { name: globalThis.Bun ? 'Bun' : 'Node', version: globalThis.Bun?.version ?? process.version,
  versions: process.versions, platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model, logicalCPUs: cpus().length, pid: process.pid } });
try {
  const start = performance.now();
  const api = await moduleAt(configuration.repo, 'dist/shared.js');
  const importMs = performance.now() - start;
  const [catalog, reads, readReference, catalogReference] = await Promise.all([
    'website/assets/catalog-core.mjs', 'website/assets/catalog-read-workloads.mjs',
    'website/assets/catalog-read-reference.mjs', 'website/assets/catalog-reference.mjs',
  ].map(path => moduleAt(configuration.harness, path)));
  const records = await runStudy(api, { catalog, reads, readReference, catalogReference }, {
    warmups: configuration.warmups, rotation: configuration.pair, cases: configuration.cases,
    hash: async text => createHash('sha256').update(text).digest('hex'),
    gc: globalThis.Bun ? () => Bun.gc(true) : globalThis.gc,
    memory: () => ({ ...process.memoryUsage(), maxRSSKiB: process.resourceUsage().maxRSS, gcAvailable: !!(globalThis.gc || globalThis.Bun) }),
    onRecord: record => emit({ type: 'sample', ...record }),
  });
  const failed = records.some(record => record.status !== 'passed');
  emit({ type: 'process-end', status: failed ? 'failed' : 'passed', endedAt: new Date().toISOString(), importMs, records: records.length,
    peakProcessRSSKiB: process.resourceUsage().maxRSS, memory: process.memoryUsage() });
  if (failed) process.exitCode = 1;
} catch (error) {
  emit({ type: 'process-failure', name: error?.name, message: error?.message ?? String(error), stack: error?.stack });
  process.exitCode = 1;
}
