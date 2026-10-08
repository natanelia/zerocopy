/** Keep the workload bounded on small devices and validate every message. */
export function validateConfig(value) {
  if (!value || ![1000, 10000, 50000].includes(value.entries) || ![1, 2, 4].includes(value.readers)) throw new RangeError('Unsupported benchmark configuration');
  return { entries: value.entries, readers: value.readers, samples: 7, warmups: 2 };
}
export function quantile(values, fraction) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new RangeError('Expected finite, nonnegative timing samples');
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * fraction;
  return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
}
export function summarize(values) { return { median: quantile(values, .5), p25: quantile(values, .25), p75: quantile(values, .75), min: Math.min(...values), max: Math.max(...values) }; }
export function expectedChecksum(entries) { return entries * (entries - 1) / 2; }
export function verifyChecksums(results, count, entries) {
  if (results.length !== count || results.some(result => result.checksum !== expectedChecksum(entries))) throw new Error('Output mismatch: benchmark results are invalid');
}
export const BENCHMARK_PATHS = ['shared', 'immutable', 'immer'];
export const BENCHMARK_LABELS = { shared: 'zerocopy shared snapshot', immutable: 'Immutable.js Map', immer: 'Immer Map' };
export function orderFor(round) {
  const offset = round % BENCHMARK_PATHS.length;
  return [...BENCHMARK_PATHS.slice(offset), ...BENCHMARK_PATHS.slice(0, offset)];
}
