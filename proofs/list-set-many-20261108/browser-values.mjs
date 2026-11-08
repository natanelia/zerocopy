export function equal(actual, expected, label = 'value') {
  if (Object.is(actual, expected)) return;
  if (Array.isArray(actual) !== Array.isArray(expected)) throw new Error(`${label}: array type mismatch`);
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) throw new Error(`${label}: length mismatch`);
    for (let i = 0; i < actual.length; i++) equal(actual[i], expected[i], `${label}[${i}]`);
    return;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const keys = Object.keys(actual).sort(), wanted = Object.keys(expected).sort();
    if (keys.length !== wanted.length || keys.some((key, i) => key !== wanted[i])) throw new Error(`${label}: keys mismatch`);
    for (const key of keys) equal(actual[key], expected[key], `${label}.${key}`);
    return;
  }
  throw new Error(`${label}: values differ`);
}

export function values(snapshot) {
  return snapshot.toArray().map(value => value && typeof value.toArray === 'function' ? values(value) : value);
}
