export const ROWS = 2048;
export const PHRASE = 'request-processing-completed-for-map-validation';
const payload = 'map tile validation successful. '.repeat(30);

// Cases and repetitions are fixed before the final comparison. Controls cover
// the existing short and insensitive paths as well as KMP's difficult inputs.
export const CASES = [
  { name: 'missing-first-byte', role: 'target', term: 'Z'.repeat(40) + 'target', caseSensitive: true, repetitions: 8,
    make: i => `log entry ${i} ` + payload },
  { name: 'late-start-hit', role: 'target', term: PHRASE[0].toUpperCase() + PHRASE.slice(1), caseSensitive: true, repetitions: 8,
    make: i => `log entry ${i} ` + payload + (i % 4 ? 'okay' : PHRASE[0].toUpperCase() + PHRASE.slice(1)) },
  { name: 'first-byte-near-end', role: 'target', term: PHRASE[0].toUpperCase() + PHRASE.slice(1), caseSensitive: true, repetitions: 8,
    make: i => `log entry ${i} ` + payload + 'R' },
  { name: 'multibyte-needle', role: 'target', term: '🚦'.repeat(9), caseSensitive: true, repetitions: 8,
    make: i => `log entry ${i} ` + payload + (i % 4 ? 'okay' : '🚦'.repeat(9)) },
  { name: 'needle-longer-than-row', role: 'target', term: PHRASE, caseSensitive: true, repetitions: 64,
    make: i => `request pending id=${i}` },
  { name: 'common-first-byte', role: 'control', term: PHRASE, caseSensitive: true, repetitions: 8,
    make: i => `log entry ${i} ` + payload + (i % 4 ? 'okay' : PHRASE) },
  { name: 'immediate-hit', role: 'control', term: PHRASE, caseSensitive: true, repetitions: 64,
    make: i => PHRASE + ` ${i} ` + payload },
  { name: 'overlapping-prefix', role: 'control', term: 'a'.repeat(64) + 'b', caseSensitive: true, repetitions: 4,
    make: i => 'a'.repeat(1024) + (i % 4 ? 'c' : 'b') + i },
  { name: 'insensitive-ascii', role: 'control', term: PHRASE, caseSensitive: false, repetitions: 8,
    make: i => `log entry ${i} ` + payload + (i % 4 ? 'okay' : PHRASE.toUpperCase()) },
  { name: 'insensitive-unicode', role: 'control', term: 'k'.repeat(40), caseSensitive: false, repetitions: 8,
    make: i => `log entry ${i} ` + payload + (i % 4 ? 'K' : 'K'.repeat(40)) },
  { name: 'short-query', role: 'control', term: 'validation', caseSensitive: false, repetitions: 256,
    make: i => `log entry ${i} ` + payload },
];

export function fixture(spec) {
  const values = Array.from({ length: ROWS }, (_, i) => spec.make(i));
  const query = spec.caseSensitive ? spec.term : spec.term.toLowerCase();
  const matches = values.map(value => (spec.caseSensitive ? value : value.toLowerCase()).includes(query));
  const checksum = matches.reduce((sum, found, i) => sum + (found ? i + ROWS + 1 : 0), 0);
  return { values, matches, checksum };
}
