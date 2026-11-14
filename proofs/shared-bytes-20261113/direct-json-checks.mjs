import assert from 'node:assert/strict';
import { parseUtf8JSON, parseUtf8JSONPlain, directJSONMetadata } from './direct-json.mjs';

const encoder = new TextEncoder();
let documents = 0, assertions = 0;

function shared(bytes) {
  const result = new Uint8Array(new SharedArrayBuffer(bytes.length + 11), 7, bytes.length);
  result.set(bytes);
  return result;
}

function frozen(value) {
  const todo = [value];
  while (todo.length) {
    const node = todo.pop();
    if (node !== null && typeof node === 'object') {
      assert.equal(Object.isFrozen(node), true); assertions++;
      for (const key of Object.keys(node)) todo.push(node[key]);
    }
  }
}

function check(json) {
  const reference = JSON.parse(json), bytes = encoder.encode(json);
  for (const input of [bytes, shared(bytes)]) {
    const result = parseUtf8JSON(input);
    assert.deepStrictEqual(result, reference); assertions++;
    frozen(result);
    assert.deepStrictEqual(parseUtf8JSONPlain(input), reference); assertions++;
    assert.deepStrictEqual(parseUtf8JSON(input, { freeze: false }), reference); assertions++;
    if (reference !== null && typeof reference === 'object') {
      assert.equal(Object.isFrozen(parseUtf8JSONPlain(input)), false); assertions++;
    }
  }
  documents++;
}

for (const json of [
  'null', 'true', 'false', '0', '-0', '1', '-1', '9007199254740991',
  '9007199254740992', '9007199254740993', '18446744073709551615',
  '1.234567890123456789', '-0.0', '1e+308', '1e309', '-1e309', '5e-324', '1e-400', '-1e-400',
  '[]', '{}', '[{},[],[null,false,0]]',
  '{"__proto__":{"polluted":true},"constructor":3,"toString":2}',
  '{"a":1,"a":2,"0":"zero","12":"twelve","02":"two"}',
  '{"__proto__":1,"__proto__":{"value":2}}',
  '"\\ud800"', '"\\udfff"', '"\\ud83d\\ude42"',
  '"\\u0000\\b\\f\\n\\r\\t\\\\\\\"\\/"',
  '"é漢字🙂𝄞"', '"a\\u0041é\\uD800𝄞\\uFEFF"',
  ' \t\n { "a" : [ 1 , 2.5 , -3e-2 ] } \r\n',
  JSON.stringify('\uFEFF'), JSON.stringify('a\uFEFFb'),
  JSON.stringify('a'.repeat(100000)), JSON.stringify('🙂漢é'.repeat(20000)),
  JSON.stringify({ ['a'.repeat(100000)]: 3 }),
]) check(json);

// Includes every UTF-16 code unit, including lone surrogates: stringify escapes
// invalid pairs while well-formed text is encoded directly by TextEncoder.
for (let base = 0; base < 65536; base += 128) {
  let value = '';
  for (let code = base; code < base + 128; code++) value += String.fromCharCode(code);
  check(JSON.stringify({ [value]: value }));
}

let seed = 0x21d4f721;
function random() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
}
const snippets = ['', 'a', 'name', 'é', '漢字', '🙂', '\uD800', '\uDFFF', '\uFEFF', '\u0000', '\n', '\\', '"', '𝄞', '\u2028', 'İΣ'];
function randomString() {
  let value = '';
  for (let i = 0, n = Math.floor(random() * 8); i < n; i++) value += snippets[Math.floor(random() * snippets.length)];
  return value;
}
function randomValue(depth = 0) {
  const kind = Math.floor(random() * (depth < 4 ? 7 : 5));
  if (kind === 0) return null;
  if (kind === 1) return random() < 0.5;
  if (kind === 2) return Math.floor((random() - 0.5) * Number.MAX_SAFE_INTEGER);
  if (kind === 3) return (random() - 0.5) * 10 ** Math.floor(random() * 600 - 300);
  if (kind === 4) return randomString();
  if (kind === 5) return Array.from({ length: Math.floor(random() * 6) }, () => randomValue(depth + 1));
  const object = {};
  for (let i = 0, n = Math.floor(random() * 6); i < n; i++) {
    Object.defineProperty(object, i % 2 ? randomString() : ['__proto__', 'name', 'items', 'price'][i % 4], {
      value: randomValue(depth + 1), configurable: true, enumerable: true, writable: true,
    });
  }
  return object;
}
for (let i = 0; i < 2000; i++) check(JSON.stringify(randomValue()));

// Decimal accumulation must subtract the ASCII bias before adding the digit;
// adding 48 first can round a near-limit safe integer to the adjacent number.
for (let i = -128n; i <= 128n; i++) {
  check((9007199254740991n + i).toString());
  check((-9007199254740991n + i).toString());
}

// Regression for prototype setters: JSON.parse creates own data properties.
Object.defineProperty(Object.prototype, 'directJSONSetterCheck', {
  configurable: true,
  set() { throw new Error('Inherited setter must not run'); },
});
try { check('{"directJSONSetterCheck":3}'); }
finally { delete Object.prototype.directJSONSetterCheck; }

// No recursive parser or freezer call stack, including on nested shared input.
const depth = 20000;
const deep = shared(encoder.encode('['.repeat(depth) + '0' + ']'.repeat(depth)));
let value = parseUtf8JSON(deep);
for (let i = 0; i < depth; i++) {
  assert.equal(Array.isArray(value), true); assert.equal(Object.isFrozen(value), true);
  value = value[0]; assertions += 2;
}
assert.equal(value, 0); assertions++; documents++;

for (const json of ['', 'undefined', 'NaN', 'Infinity', '-', '+1', '.1', '01', '-01', '1.', '1e', '1e+',
  '[1,]', '{"a":1,}', '[,1]', '{a:1}', '{"a" 1}', '[true false]', 'null null', '"unterminated',
  '"\\uFFF"', '"\\uGGGG"', '"\\x12"', '"a\nb"', '[', '{', '[1', '{"a":1', 'tru', 'falsee']) {
  assert.throws(() => parseUtf8JSON(encoder.encode(json)), SyntaxError); assertions++;
}
assert.throws(() => parseUtf8JSON(new ArrayBuffer(8)), TypeError); assertions++;

console.log(JSON.stringify({ status: 'pass', documents, assertions, metadata: directJSONMetadata }));
