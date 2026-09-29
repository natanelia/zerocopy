// Deterministic xorshift32. Failure messages include the seed and input shape.
export function random(seed) {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
export function coordinates(seed, count, kind = 'random') {
  const rng = random(seed), out = [];
  for (let i = 0; i < count; i++) {
    const x = kind === 'road' ? i * 0.125 : (rng() - 0.5) * 10000;
    const y = kind === 'road' ? Math.sin(i / 31) * 10 + (rng() - 0.5) / 100 : (rng() - 0.5) * 10000;
    out.push(x, y);
  }
  return out;
}
export function bboxReference(values) {
  const result = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < values.length; i += 2) {
    if (values[i] < result[0]) result[0] = values[i];
    if (values[i + 1] < result[1]) result[1] = values[i + 1];
    if (values[i] > result[2]) result[2] = values[i];
    if (values[i + 1] > result[3]) result[3] = values[i + 1];
  }
  return result;
}
export function pairs(values) {
  const result = [];
  for (let i = 0; i < values.length; i += 2) result.push([values[i], values[i + 1]]);
  return result;
}
export function exact(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, i) => !Object.is(value, expected[i]))) {
    throw new Error(`${label}: exact comparison failed at index ${actual.findIndex((v, i) => !Object.is(v, expected[i]))}; length ${actual.length}/${expected.length}`);
  }
}
