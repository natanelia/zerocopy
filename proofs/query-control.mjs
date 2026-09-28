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
  let result = baseline.slice(0, before.start) + candidate.slice(after.start, after.end) + baseline.slice(before.end);
  result = addTextMatcherAdapter(result);
  if (result !== candidate) throw new Error('Query or fixture code differs outside the scheduler or text-matcher adapter; an engine-only comparison is not valid');
  return result;
}

/** Match only the optional per-query accessor; old runtimes fall back to get.
 * The iteration order, predicate semantics and checkpoint schedule cannot change.
 */
export function addTextMatcherAdapter(source) {
  if (source.includes('compileTextSearch: typeof columns.message.compileTextSearch')) return source;
  const replacements = [
    ["return { length, get: (field, index) => columns[field].get(index) };", "return { length, get: (field, index) => columns[field].get(index),\n    compileTextSearch: typeof columns.message.compileTextSearch === 'function'\n      ? term => columns.message.compileTextSearch(term, { caseSensitive: false }) : undefined };"],
    ['export function matches(view, index, query) {', 'export function matches(view, index, query, containsText) {'],
    ["return !query.term || view.get('message', index).toLowerCase().includes(query.term);", "return !query.term || (containsText ? containsText(index) : view.get('message', index).toLowerCase().includes(query.term));"],
    ['const query = normalizeQuery(input), indices = [];', 'const query = normalizeQuery(input), indices = [];\n  const containsText = query.term ? view.compileTextSearch?.(query.term) : undefined;'],
    ['const query = normalizeQuery(input);\n  const begin', 'const query = normalizeQuery(input);\n  const containsText = query.term ? view.compileTextSearch?.(query.term) : undefined;\n  const begin'],
    ['!matches(view, index, query)', '!matches(view, index, query, containsText)'],
  ];
  for (const [before, after] of replacements) {
    if (!source.includes(before)) throw new Error('Unknown text matcher adapter layout');
    source = source.replaceAll(before, after);
  }
  return source;
}
