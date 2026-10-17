import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cases } from './vector-compaction-cases.mjs';

const paths = process.argv.slice(2);
assert.ok(paths.length, 'Pass one or more benchmark results.json files');
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
let state = 20261017;
const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
function interval(groups) {
  const means = groups.map(values => mean(values));
  const draws = [];
  for (let sample = 0; sample < 20000; sample++) {
    draws.push(Math.exp(mean(groups.map(values => {
      let sum = 0;
      for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)];
      return sum / values.length;
    }))));
  }
  draws.sort((a, b) => a - b);
  return { ratio: Math.exp(mean(means)), lower: draws[500], upper: draws[19499] };
}
for (const path of paths) {
  const record = JSON.parse(readFileSync(path)), expected = record.protocol.pairs;
  const full = record.complete && record.pairs === expected && record.rows.length === cases.length
    && cases.every(spec => record.rows.some(row => row.name === spec.name && row.pairs.length === expected));
  const rows = record.rows.map(row => {
    assert.ok(row.pairs.length, `No pairs for ${row.name}`);
    const result = interval([row.pairs.map(pair => Math.log(pair.timeRatio))]);
    return { name: row.name, ...result, speedup: 1 / result.ratio, baselineMs: mean(row.pairs.map(pair => pair.baseline)), candidateMs: mean(row.pairs.map(pair => pair.candidate)), status: result.upper <= 1.05 ? 'clear within 5% bound' : result.lower > 1.05 ? 'regression' : 'unresolved' };
  });
  const primaryRows = record.rows.filter(row => record.protocol.primaryCases.includes(row.name));
  const primary = primaryRows.length === record.protocol.primaryCases.length ? interval(primaryRows.map(row => row.pairs.map(pair => Math.log(pair.timeRatio)))) : null;
  const accepted = full && primary?.upper < 0.90 && rows.every(row => row.status === 'clear within 5% bound');
  const summary = { fullProtocol: full, accepted, primary, rows, method: '20,000 seeded bootstrap draws over paired log time ratios; primary cases receive equal weight. Intervals are descriptive marginal 95% intervals, not simultaneous guarantees.' };
  writeFileSync(resolve(path, '..', 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(path, JSON.stringify({ fullProtocol: full, accepted, primary }));
  for (const row of rows) console.log(`${row.name}: ${row.speedup.toFixed(3)}x; time ratio [${row.lower.toFixed(3)}, ${row.upper.toFixed(3)}]; ${row.status}`);
  if (process.env.PERF_GATE === '1' && !accepted) process.exitCode = 1;
}
