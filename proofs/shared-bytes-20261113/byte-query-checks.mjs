import assert from 'node:assert/strict';
import { compileJsonFieldEquals, compileJsonNumberField, compileJsonFieldNumberRange } from './byte-query.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let checks = 0;

function check(value, fields, needles) {
  const text = JSON.stringify(value);
  const source = encoder.encode(text);
  // Match the current codec even if rawJSON supplies a literal lone surrogate.
  const reference = JSON.parse(decoder.decode(source));
  const eligible = reference !== null && typeof reference === 'object' && !Array.isArray(reference);
  for (const shared of [false, true]) {
    // Read a bounded record in a larger arena, with adversarial data on both sides.
    const offset = 19;
    const storage = shared ? new SharedArrayBuffer(source.length + 71) : new ArrayBuffer(source.length + 71);
    const bytes = new Uint8Array(storage);
    bytes.fill(125);
    bytes.set(source, offset);
    for (const field of fields) {
      const owns = eligible && Object.hasOwn(reference, field);
      const scalar = owns ? reference[field] : undefined;
      for (const expected of needles) {
        assert.equal(
          compileJsonFieldEquals(field, expected)(bytes, offset, offset + source.length),
          owns && scalar === expected,
          `${shared ? 'SAB' : 'AB'}: ${text}, field ${JSON.stringify(field)}, expected ${String(expected)}`,
        );
        checks++;
      }
      const number = typeof scalar === 'number' ? scalar : undefined;
      assert.ok(Object.is(compileJsonNumberField(field)(bytes, offset, offset + source.length), number));
      checks++;
      for (const [minimum, maximum] of [[-Infinity, Infinity], [-10, 10], [0, 0], [42, 9999]]) {
        assert.equal(
          compileJsonFieldNumberRange(field, minimum, maximum)(bytes, offset, offset + source.length),
          number !== undefined && number >= minimum && number <= maximum,
        );
        checks++;
      }
    }
  }
}

const strings = [
  '', 'books', 'book', 'booksx', 'electronics', 'null', 'false', '123',
  '"\\\n\t\r\b\f/', 'quoted "category":"books"', '{}[],:', '\u0000',
  'é', 'e\u0301', '世界', '🙂', '\ud800', '\udc00', '\ud800a', '\udc00\ud800',
  '\ud83d\ude42', '\ufeff', '\u2028\u2029', '\u007f\u0080\u07ff\u0800\uffff',
];
const numbers = [
  0, -0, 1, -1, 42, 9999, 0.1, 1e-7, 1e21, Number.MIN_VALUE,
  Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 8,
  Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 99,
  -Number.MAX_SAFE_INTEGER, 2.2250738585072014e-308,
];
const needles = [...strings, ...numbers, true, false, null, Infinity, -Infinity, NaN];
const fields = ['category', 'revision', 'missing', '__proto__', 'toString', ...strings];
const nested = {
  category: 'books', revision: 42,
  arr: [{ category: 'electronics', revision: 42 }, '"category":"books"', [1, 2, [3]]],
  text: 'before { "category":"books", "revision":42 } after \\\"',
};

for (const scalar of [...strings, ...numbers, true, false, null]) {
  check({ category: scalar, revision: scalar, after: nested }, ['category', 'revision', 'missing'], needles);
  check({ before: nested, padding: 'x'.repeat(1000), category: scalar, revision: scalar }, ['category', 'revision', 'missing'], needles);
}
for (const field of fields) {
  const value = { before: nested, [field]: 'books', after: [nested] };
  check(value, [field, 'missing'], needles);
}
for (const value of [null, 0, true, 'books', ['books', 42], {}, { before: nested, after: nested }]) {
  check(value, ['category', 'revision', '0', 'length', 'toString'], needles);
}

if (typeof JSON.rawJSON === 'function') {
  const rawTokens = [
    '"\\u0062ooks"', '"\\u0062\\u006f\\u006f\\u006b\\u0073"',
    '"\\/"', '"\\uD83D\\uDE42"', '"\\ud800"', '"\\u0000"',
    '"\\u0022\\u005c\\u000a\\u0009\\u000d\\u0008\\u000c\\/"',
    '"\ud800"', '-0', '1e0', '0.1e1', '0.1000000000000000055511151231257827021181583404541015625',
    '1e400', '-1e400', '1e-400', '-1e-400', '9007199254740993',
    'null', 'true', 'false',
  ];
  for (const token of rawTokens) {
    check({ category: JSON.rawJSON(token), revision: JSON.rawJSON(token), after: nested }, ['category', 'revision', 'missing'], needles);
  }
}

// Deterministic varied shapes/values, so this isn't only a mirror of hand cases.
let state = 0x7f214d9a;
function random() { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }
const leaves = [...strings, ...numbers, true, false, null];
function value(depth) {
  if (!depth || (random() & 3) === 0) return leaves[random() % leaves.length];
  if (random() & 1) return Array.from({ length: random() % 4 }, () => value(depth - 1));
  const result = {};
  for (let i = 0, n = random() % 5; i < n; i++) {
    Object.defineProperty(result, fields[random() % fields.length], { value: value(depth - 1), enumerable: true, configurable: true });
  }
  return result;
}
for (let i = 0; i < 150; i++) {
  const record = { before: value(3), category: value(3), revision: value(2), after: value(3) };
  check(record, ['category', 'revision', 'missing'], needles);
}

// Integer accumulation must subtract the ASCII offset before adding the digit:
// adding a 48..57 byte first can round an otherwise exactly representable value.
for (let n = Number.MAX_SAFE_INTEGER - 100; n <= Number.MAX_SAFE_INTEGER; n++) {
  for (const signed of [n, -n]) {
    const bytes = encoder.encode(JSON.stringify({ revision: signed }));
    assert.equal(compileJsonNumberField('revision')(bytes), signed);
    assert.equal(compileJsonFieldEquals('revision', signed)(bytes), true);
    checks += 2;
  }
}

assert.throws(() => compileJsonFieldEquals('x', {}), TypeError);
assert.throws(() => compileJsonFieldEquals(4, 'x'), TypeError);
assert.throws(() => compileJsonFieldNumberRange('x', 2, 1), TypeError);
assert.throws(() => compileJsonFieldNumberRange('x', NaN, 1), TypeError);
checks += 4;
console.log(JSON.stringify({ checks, status: 'pass', rawJSON: typeof JSON.rawJSON === 'function' }));
