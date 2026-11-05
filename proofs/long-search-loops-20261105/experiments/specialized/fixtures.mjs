export const ROWS = 2048;
export const PHRASE = 'request-processing-completed-for-map-validation';
const payload = 'map tile validation successful. '.repeat(30);

// Freeze the same eleven datasets used for #46, plus three declared controls,
// before measuring any candidate. Repetitions are equal for both builds.
export const CASES = [
  { name: 'missing-first-byte', role: 'preservation', term: 'Z'.repeat(40) + 'target', caseSensitive: true, repetitions: 64,
    make: i => `log entry ${i} ` + payload },
  { name: 'late-start-hit', role: 'preservation', term: PHRASE[0].toUpperCase() + PHRASE.slice(1), caseSensitive: true, repetitions: 64,
    make: i => `log entry ${i} ` + payload + (i % 4 ? 'okay' : PHRASE[0].toUpperCase() + PHRASE.slice(1)) },
  { name: 'first-byte-near-end', role: 'preservation', term: PHRASE[0].toUpperCase() + PHRASE.slice(1), caseSensitive: true, repetitions: 64,
    make: i => `log entry ${i} ` + payload + 'R' },
  { name: 'multibyte-needle', role: 'preservation', term: '🚦'.repeat(9), caseSensitive: true, repetitions: 64,
    make: i => `log entry ${i} ` + payload + (i % 4 ? 'okay' : '🚦'.repeat(9)) },
  { name: 'needle-longer-than-row', role: 'preservation', term: PHRASE, caseSensitive: true, repetitions: 512,
    make: i => `request pending id=${i}` },
  { name: 'common-first-byte', role: 'control', term: PHRASE, caseSensitive: true, repetitions: 8,
    make: i => `log entry ${i} ` + payload + (i % 4 ? 'okay' : PHRASE) },
  { name: 'immediate-hit', role: 'target', term: PHRASE, caseSensitive: true, repetitions: 128,
    make: i => PHRASE + ` ${i} ` + payload },
  { name: 'overlapping-prefix', role: 'target', term: 'a'.repeat(64) + 'b', caseSensitive: true, repetitions: 4,
    make: i => 'a'.repeat(1024) + (i % 4 ? 'c' : 'b') + i },
  { name: 'insensitive-ascii', role: 'control', term: PHRASE, caseSensitive: false, repetitions: 8,
    make: i => `log entry ${i} ` + payload + (i % 4 ? 'okay' : PHRASE.toUpperCase()) },
  { name: 'insensitive-unicode', role: 'control', term: 'k'.repeat(40), caseSensitive: false, repetitions: 8,
    make: i => `log entry ${i} ` + payload + (i % 4 ? 'K' : 'K'.repeat(40)) },
  { name: 'short-query', role: 'control', term: 'validation', caseSensitive: false, repetitions: 512,
    make: i => `log entry ${i} ` + payload },
  { name: 'immediate-hit-33-bytes', role: 'control', term: 'request-processing-completed-okay', caseSensitive: true, repetitions: 128,
    make: i => 'request-processing-completed-okay' + ` ${i} ` + payload },
  { name: 'common-suffix-middle-mismatch', role: 'control', term: 'a'.repeat(32) + 'b' + 'a'.repeat(32), caseSensitive: true, repetitions: 4,
    make: i => 'a'.repeat(1024) + i },
  { name: 'early-false-suffix-candidates', role: 'control', term: 'a'.repeat(64) + 'b', caseSensitive: true, repetitions: 8,
    make: i => ('a'.repeat(40) + 'b').repeat(25) + i },
];

export function fixture(spec) {
  const values = Array.from({ length: ROWS }, (_, i) => spec.make(i));
  const query = spec.caseSensitive ? spec.term : spec.term.toLowerCase();
  const matches = values.map(value => (spec.caseSensitive ? value : value.toLowerCase()).includes(query));
  const checksum = matches.reduce((sum, found, i) => sum + (found ? i + ROWS + 1 : 0), 0);
  return { values, matches, checksum };
}
