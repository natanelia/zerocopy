/** Keep control edits explicit and reject unaccounted query/fixture changes. */
export function matchScheduler(baseline, candidate) {
  function region(source) {
    const end = source.indexOf('/** Periodic task-queue yields');
    const modern = source.indexOf('// Yield a real task');
    const start = modern >= 0 ? modern : source.indexOf('export const yieldToEvents =');
    if (start < 0 || end <= start) throw new Error('Unknown scheduler layout; update the benchmark control explicitly');
    return { start, end };
  }
  const before = region(baseline), after = region(candidate);
  const result = baseline.slice(0, before.start) + candidate.slice(after.start, after.end) + baseline.slice(before.end);
  if (result !== candidate) throw new Error('Query or fixture code differs outside the scheduler; an engine-only comparison is not valid');
  return result;
}
