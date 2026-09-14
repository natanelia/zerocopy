import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = process.argv[2] ? pathToFileURL(resolve(process.argv[2]) + sep) : new URL('./results/', import.meta.url);
const inputs = [1, 2, 3].map(round => {
  const path = `readme-libraries-round-${round}.json`, bytes = readFileSync(new URL(path, directory));
  const data = JSON.parse(bytes);
  assert.equal(data.round, round); assert.equal(data.N, 10000); if (!data.caseFilter) assert.equal(data.rows.length, 89);
  assert.equal(new Set(data.rows.map(r => `${r.group}:${r.operation}:${r.kind}`)).size, data.rows.length);
  for (const row of data.rows) {
    assert.equal(row.samplesMs.length, 15);
    assert(row.samplesMs.every(x => Number.isFinite(x) && x > 0));
  }
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), data };
});
const first = inputs[0].data;
for (const { data } of inputs) {
  for (const key of ['engineSHA256', 'wasmSHA256', 'benchmarkSHA256', 'sourceCommit', 'warmups', 'includeArenaSetup', 'caseFilter']) assert.equal(data[key], first[key]);
  assert.deepEqual(data.runtime, first.runtime);
}
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rows = [];
for (const row of first.rows) {
  if (row.kind !== 'shared') continue;
  const variants = first.rows.filter(r => r.group === row.group && r.operation === row.operation);
  const ms = Object.fromEntries(variants.map(variant => {
    const times = inputs.flatMap(({ data }) => {
      const match = data.rows.find(r => r.group === row.group && r.operation === row.operation && r.kind === variant.kind);
      assert(match); assert.equal(match.operationsPerWorkload, variant.operationsPerWorkload); assert.equal(match.workloadsPerSample, variant.workloadsPerSample);
      return match.samplesMs;
    });
    assert.equal(times.length, 45); return [variant.kind, median(times)];
  }));
  rows.push({ group: row.group, operation: row.operation, operationsPerWorkload: row.operationsPerWorkload, workloadsPerSample: row.workloadsPerSample, ...ms,
    versusImmutable: ms.immutable === undefined ? null : ms.immutable / ms.shared, versusNative: ms.native / ms.shared });
}
if (!first.caseFilter) assert.equal(rows.length, 36);
const summary = { schema: 1, comparison: 'Zerocopy vs Immutable.js vs native', N: first.N, sourceCommit: first.sourceCommit,
  measuredAt: inputs.map(x => x.data.measuredAt), runtime: first.runtime, rounds: 3, samplesPerVariant: 45, totalSamples: first.rows.length * 45, warmups: first.warmups, includeArenaSetup: first.includeArenaSetup ?? true, caseFilter: first.caseFilter ?? null,
  engineSHA256: first.engineSHA256, wasmSHA256: first.wasmSHA256, benchmarkSHA256: first.benchmarkSHA256,
  rawFiles: inputs.map(({ path, sha256 }) => ({ path, sha256 })), rows };
writeFileSync(new URL('readme-libraries-summary.json', directory), JSON.stringify(summary) + '\n');
const titles = {
  SharedMap: 'SharedMap vs Immutable.Map vs Native Map', SharedList: 'SharedList vs Immutable.List vs Native Array',
  SharedStack: 'SharedStack vs Immutable.Stack vs Native Array', SharedQueue: 'SharedQueue vs Native Array',
  SharedLinkedList: 'SharedLinkedList vs Native Array', SharedDoublyLinkedList: 'SharedDoublyLinkedList vs Native Array',
  SharedOrderedMap: 'SharedOrderedMap vs Immutable.OrderedMap vs Native Map', SharedSortedMap: 'SharedSortedMap vs Native Map'
};
const time = ms => `${ms.toFixed(ms < 0.01 ? 6 : 4)}ms`;
const ratio = n => `${(n >= 1 ? n : 1 / n).toFixed(2)}x ${n >= 1 ? 'faster' : 'slower'}`;
const table = [];
for (const [group, title] of Object.entries(titles)) {
  const groupRows = rows.filter(r => r.group === group);
  if (!groupRows.length) continue;
  const hasImmutable = groupRows[0].immutable !== undefined;
  table.push(`**${title}**`, hasImmutable ? '| Operation | Shared | Immutable | vs Imm | Native | vs Native |' : '| Operation | Shared | Native | vs Native |',
    hasImmutable ? '|-----------|--------|-----------|--------|--------|-----------|' : '|-----------|--------|--------|-----------|');
  for (const row of groupRows) table.push(hasImmutable
    ? `| ${row.operation} | ${time(row.shared)} | ${time(row.immutable)} | ${ratio(row.versusImmutable)} | ${time(row.native)} | ${ratio(row.versusNative)} |`
    : `| ${row.operation} | ${time(row.shared)} | ${time(row.native)} | ${ratio(row.versusNative)} |`);
  table.push('');
}
writeFileSync(new URL('readme-libraries-tables.md', directory), table.join('\n'));
console.log(`Verified ${summary.totalSamples} samples; rendered ${rows.length} rows in the original eight-table format.`);
