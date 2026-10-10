import { memoryFigure } from './memory-charts.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const record = JSON.parse(readFileSync(new URL('./recorded-memory.json', import.meta.url), 'utf8'));
const mib = bytes => (bytes / 1048576).toFixed(2);
export function recordedMemory(base) {
  assert.equal(record.entries, 100000); assert.equal(record.readers, 2); assert.equal(record.trials, 3);
  assert.equal(record.rows.length, 3);
  const labels = { repeated: 'Repeated messages', unique: 'Unique messages', unicode: '20% Unicode prefix' };
  const rows = record.rows.map(row => {
    assert.ok(labels[row.fixture]);
    for (const kind of ['shared', 'immutable', 'native', 'centralized']) assert.ok(Number.isFinite(row[kind]) && row[kind] > 0);
    return `<tr><th scope="row">${labels[row.fixture]}</th><td>${mib(row.shared)}</td><td>${mib(row.immutable)}</td><td>${mib(row.native)}</td><td>${mib(row.centralized)}</td></tr>`;
  }).join('');
  return `<section class="section recorded-memory prose" aria-labelledby="recorded-memory-title"><span class="eyebrow">RECORDED MEMORY · NOT A LIVE BROWSER METER</span><h2 id="recorded-memory-title">Count the memory, too.</h2><p>100,000 events. One owner and two readers for Shared, Immutable.js and Native replicas. One native owner has no reader replicas. Compare retained data with total process RAM. Each graph has its own labelled, zero-based scale. The full table below shows post-query retained data memory, in MiB. Lower is better.</p><div class="memory-overview">${memoryFigure('retained',base)}${memoryFigure('rss',base)}</div><div class="table-scroll" tabindex="0" role="region" aria-label="Recorded worker memory comparison"><table><caption>Node.js worker measurements · median of three fresh processes · 10 October 2026</caption><thead><tr><th scope="col">Input</th><th scope="col">Shared</th><th scope="col">Immutable.js</th><th scope="col">Native replicas</th><th scope="col">One native owner</th></tr></thead><tbody>${rows}</tbody></table></div><p>Includes every worker's JavaScript heap change, tracked buffers, caches, and current shared WASM capacity counted once. Excludes the empty-worker baseline. These are Node.js measurements, not measurements of this device or browser. The live event selector does not change this table.</p><p>Total process RAM gives a different result: the one-native-owner control uses the least RSS in this run. Read the full report for RSS, peak process RAM, reader scaling, old snapshots and limits.</p><a class="text-link" href="${base}docs/memory-comparison/">Read the memory comparison and method →</a></section>`;
}
