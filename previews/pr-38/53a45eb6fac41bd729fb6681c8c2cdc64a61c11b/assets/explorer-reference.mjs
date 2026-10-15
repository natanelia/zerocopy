import { BUCKETS, START_TIME, STEP_MS } from './explorer-core.mjs';
/** Independent array oracle. Deliberately does not call the demo's filter or scan functions. */
export function reference(columns, input = {}) {
  const term = (input.term ?? '').trim().toLowerCase(), length = columns.time.length;
  const begin = length ? columns.time[0] : START_TIME, end = length ? columns.time[length - 1] + STEP_MS : begin + 1;
  const selected = [];
  const summary = { total: 0, checksum: 0, counts: Array(BUCKETS).fill(0), errors: Array(BUCKETS).fill(0), services: [0, 0, 0, 0], errorCount: 0, latencySum: 0, begin, end };
  for (let i = 0; i < length; i++) {
    if (input.service != null && input.service !== -1 && input.service !== columns.service[i]) continue;
    if (input.level != null && input.level !== -1 && input.level !== columns.level[i]) continue;
    if (input.from != null && columns.time[i] < input.from) continue;
    if (input.to != null && columns.time[i] >= input.to) continue;
    if (term && !columns.message[i].toLowerCase().includes(term)) continue;
    selected.push(i); summary.total++; summary.checksum = (summary.checksum + i) >>> 0;
    const bucket = Math.min(BUCKETS - 1, Math.floor((columns.time[i] - begin) * BUCKETS / (end - begin)));
    summary.counts[bucket]++; summary.services[columns.service[i]]++; summary.latencySum += columns.latency[i];
    if (columns.level[i] === 2) { summary.errors[bucket]++; summary.errorCount++; }
  }
  const indices = selected.reverse().slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 50));
  const rows = indices.map(index => ({ index, time: columns.time[index], service: columns.service[index], level: columns.level[index], latency: columns.latency[index], message: columns.message[index] }));
  return { search: { total: summary.total, checksum: summary.checksum, indices }, summary, rows };
}
export function verifyAnswer(actual, expected) {
  for (const key of ['search', 'summary', 'rows']) {
    // Stable projections avoid depending on object insertion order in transport.
    if (JSON.stringify(canonical(actual[key])) !== JSON.stringify(canonical(expected[key]))) throw new Error(`Reference mismatch: ${key}`);
  }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
