/** Explicit workload matrix. History counts are fixture data, not tuning knobs. */
export function workloadCases(filter) {
  const rows = [];
  const add = (suite, kind, type, size, history, operation = 'entries', pattern = 'rotate') => rows.push({ suite, kind, type, size, history, operation, pattern,
    name: `${suite}/${kind}/${type}/${size}/${history}/${pattern}/${operation}` });
  for (const size of [1, 32, 4096]) for (const kind of ['ordered', 'replaced']) add('controls', kind, 'number', size, size);
  add('controls', 'ordered', 'object', 32, 36); add('controls', 'ordered', 'object', 4096, 4608);
  add('controls', 'sorted-custom', 'object', 4096, 4096); add('controls', 'sorted', 'number', 32, 32);
  add('controls', 'map', 'number', 4096, 4096); add('controls', 'list', 'number', 4096, 4096, 'values');
  for (const size of [2, 32, 4096]) {
    const bound = size * (2 + Math.ceil(Math.log2(size)));
    for (const history of [bound - 1, bound, bound + 1]) add('crossover', 'ordered', 'number', size, history);
  }
  for (const size of [1, 32, 4096]) add('targets', 'ordered', 'number', size, size * 64);
  add('targets', 'ordered', 'number', 32, 8192, 'entries', 'hot');
  for (const type of ['string', 'object']) add('targets', 'ordered', type, 256, 16384);
  add('targets', 'ordered', 'number', 256, 16384, 'keys'); add('targets', 'ordered', 'object', 256, 16384, 'values');
  add('targets', 'ordered', 'number', 256, 16384, 'forEach');
  for (const size of [32, 4096]) add('targets', 'ordered-set', 'number', size, size * 64, 'values');
  for (const row of rows) row.gate =
    row.suite === 'controls' && (row.kind === 'ordered' && row.type === 'number' && row.size >= 32 || row.kind === 'replaced' || row.kind === 'sorted-custom') ||
    row.suite === 'crossover' && row.size >= 32 ||
    row.suite === 'targets' && row.kind === 'ordered' && row.type === 'number' && row.operation === 'entries' && row.pattern === 'rotate' && row.size >= 32;
  return filter ? rows.filter(row => new RegExp(filter).test(row.name)) : rows;
}
