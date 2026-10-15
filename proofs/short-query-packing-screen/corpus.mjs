/** Frozen deterministic inputs; this module never imports zerocopy. */
export const CASES = Object.freeze(['P1', 'S1', 'C1', 'C2', 'C3', 'C4']);
export const SPECS = Object.freeze([
  { id: 'one', term: 'x', caseSensitive: true, hit: 'x' },
  { id: 'four', term: 'warn', caseSensitive: false, hit: 'WARN' },
  { id: 'five', term: 'café', caseSensitive: true, hit: 'café' },
  { id: 'eight', term: 'GET /api', caseSensitive: true, hit: 'GET /api' },
  { id: 'nine', term: 'requestId', caseSensitive: false, hit: 'REQUESTID' },
  { id: 'thirteen', term: 'authorization', caseSensitive: false, hit: 'AUTHORIZATION' },
  { id: 'sixteen', term: 'user@example.com', caseSensitive: true, hit: 'user@example.com' },
  { id: 'astral', term: '😀😀😀😀', caseSensitive: true, hit: '😀😀😀😀' },
  { id: 'skip', term: 'abcdefghijklmnopqrstuvwx', caseSensitive: true, hit: 'abcdefghijklmnopqrstuvwx' },
  { id: 'kmp', term: '0123456789'.repeat(4), caseSensitive: false, hit: '0123456789'.repeat(4) },
  { id: 'dotted', term: 'İ', caseSensitive: false, hit: 'İ' },
  { id: 'sigma', term: 'Σ', caseSensitive: false, hit: 'ΟΣΑ' },
  { id: 'sharp', term: 'ß', caseSensitive: false, hit: 'ẞ' },
  { id: 'surrogate', term: '\ud83d', caseSensitive: true, hit: '😀' },
].map(Object.freeze));

// For even matching indices, sum(i + 1) = (rowCount / 2)^2.
// Short-query weights sum to 36; long weights sum to 3; fallback weights to 10.
// S1 visits each query's hit at index 0 and miss at index 1 exactly once.
export const EXPECTED = Object.freeze({
  P1: { checksum: 2304, operations: 8, hits: 64 },
  S1: { checksum: 36, operations: 16, hits: 8 },
  C1: { checksum: 150994944, operations: 8, hits: 16384 },
  C2: { checksum: 150994944, operations: 8, hits: 16384 },
  C3: { checksum: 192, operations: 2, hits: 16 },
  C4: { checksum: 640, operations: 4, hits: 32 },
});

export function makeCorpus() {
  return SPECS.map((spec, j) => {
    const count = j < 8 ? 4096 : 16;
    const values = Array.from({ length: count }, (_, i) => {
      const fill = ' . '.repeat(48);
      const position = [0, 40, 100][(i >>> 1) % 3];
      const token = i % 2 === 0 ? spec.hit : '-'.repeat(spec.hit.length);
      return '2026-01-01 info row=' + String(i).padStart(4, '0') + ' status=ok '
        + fill.slice(0, position) + token + fill.slice(position);
    });
    return { ...spec, options: { caseSensitive: spec.caseSensitive }, values };
  });
}

export function entriesFor(id, entries) {
  if (!CASES.includes(id)) throw new Error('unknown workload');
  return id === 'C3' ? entries.slice(8, 10) : id === 'C4' ? entries.slice(10) : entries.slice(0, 8);
}

export function referenceMatch(entry, value) {
  return entry.caseSensitive ? value.includes(entry.term)
    : value.toLowerCase().includes(entry.term.toLowerCase());
}

export function oracle(id, entries) {
  let checksum = 0, hits = 0;
  const group = entriesFor(id, entries), count = id === 'C1' || id === 'C2' ? 4096 : 16;
  for (let pass = 0; pass < (id === 'S1' ? 2 : 1); pass++) {
    for (let j = 0; j < group.length; j++) {
      const indices = id === 'S1' ? [(pass + j) & 1] : Array.from({ length: count }, (_, i) => i);
      for (const i of indices) if (referenceMatch(group[j], group[j].values[i])) {
        checksum += (j + 1) * (i + 1); hits++;
      }
    }
  }
  return { checksum, operations: EXPECTED[id].operations, hits };
}
