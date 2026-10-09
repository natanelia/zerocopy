import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = '/workspace/shared/zerocopy-block-callback-traversal-20261009/sources';
const sources = Object.fromEntries(await Promise.all(['main', 'candidate'].map(async subject => [subject, await import(pathToFileURL(`${root}/${subject}/dist/shared.js`).href)])));
const modes = ['linked', 'doubly', 'reverse'];
const cases = ['plain', 'default-getter', 'custom-complete', 'callback-throw', 'decode-getter-throw', 'decode-throw', 'next-throw', 'value-getter-throw', 'close-throws'];
const results = {};

function fixture(S, mode, count) {
  const C = mode === 'linked' ? S.SharedLinkedList : S.SharedDoublyLinkedList;
  const Arena = C.owner(new C('number')).constructor;
  const arena = new Arena({ memory: new WebAssembly.Memory({ initial: 2, maximum: 256, shared: true }) });
  let list = new C('number', 0, 0, 0, arena);
  for (let i = 0; i < count; i++) list = list.append(i);
  return { list, arena };
}

function observe(S, mode, count, scenario) {
  const { list, arena } = fixture(S, mode, count), events = [];
  const blocks = arena.blocks, decode = arena.decode;
  const primary = new Error('primary'), cleanup = new Error('cleanup');
  const custom = scenario !== 'plain' && scenario !== 'default-getter';
  let decodeGets = 0;
  Object.defineProperty(arena, 'decode', { get() {
    events.push(['decode:get', ++decodeGets]);
    if (scenario === 'decode-getter-throw' && decodeGets === (mode === 'reverse' ? list.tailSize + 2 : 2)) throw primary;
    return function(type, raw) {
      events.push(['decode', this === arena, type, raw]);
      if (scenario === 'decode-throw' && raw === 101) throw primary;
      return decode.call(this, type, raw);
    };
  } });
  if (custom) {
    const method = new Proxy(function() {}, { apply(_target, receiver, args) {
      events.push(['blocks:call', receiver === arena, args.length, args[0] === list.head, args[1] ?? null]);
      let next = 0;
      const iterator = {
        get next() {
          events.push('next:get');
          return function() {
            events.push(['next', this === iterator, next]);
            if (scenario === 'next-throw' && next === 1) throw primary;
            const ordinal = next++;
            return {
              get done() { events.push(['done:get', ordinal]); return ordinal >= 3; },
              get value() { events.push(['value:get', ordinal]); if (scenario === 'value-getter-throw' && ordinal === 1) throw primary; return 100 + ordinal; },
            };
          };
        },
        get return() {
          events.push('return:get');
          return function() { events.push(['return', this === iterator]); if (scenario === 'close-throws') throw cleanup; return {}; };
        },
      };
      const iterable = { get [Symbol.iterator]() {
        events.push('iterator:get');
        return function() { events.push(['iterator:call', this === iterable]); return iterator; };
      } };
      return iterable;
    } });
    Object.defineProperty(method, 'call', { value() { throw new Error('own call must not be used'); } });
    Object.defineProperty(arena, 'blocks', { get() { events.push('blocks:get'); return method; } });
  } else if (scenario === 'default-getter') {
    Object.defineProperty(arena, 'blocks', { get() { events.push('blocks:get'); return blocks; } });
  }
  const callback = function(value, index) {
    events.push(['callback', this === undefined, arguments.length, value, index]);
    if ((scenario === 'callback-throw' || scenario === 'close-throws') && value === 101) throw primary;
  };
  let error = null, returned;
  try { returned = mode === 'reverse' ? list.forEachReverse(callback) : list.forEach(callback); }
  catch (e) { error = e === primary ? 'primary' : e === cleanup ? 'cleanup' : [e.name, e.message]; }
  assert.equal(returned, undefined);
  return { events, error };
}

let differentialCases = 0;
for (const mode of modes) for (const count of [0, 1, 65]) for (const scenario of cases) {
  const name = `${mode}/${count}/${scenario}`;
  const main = observe(sources.main, mode, count, scenario);
  const candidate = observe(sources.candidate, mode, count, scenario);
  assert.deepEqual(candidate, main, name);
  results[name] = candidate;
  differentialCases++;
}

assert.deepEqual(Object.keys(sources.candidate).sort(), Object.keys(sources.main).sort());
const declarations = ['shared.d.ts', 'shared-linked-list.d.ts', 'shared-doubly-linked-list.d.ts'];
for (const name of declarations) assert.equal(readFileSync(`${root}/candidate/dist/types/${name}`, 'utf8'), readFileSync(`${root}/main/dist/types/${name}`, 'utf8'), name);
assert.equal('forEachBlockValue' in sources.candidate, false);
const receipt = {
  runtime: process.version,
  bun: globalThis.Bun?.version ?? null,
  differentialCases,
  subjectExecutions: differentialCases * 2,
  modes,
  sizes: [0, 1, 65],
  scenarios: cases,
  rootExportsEqual: true,
  rootExportCount: Object.keys(sources.candidate).length,
  publicDeclarationFilesEqual: declarations,
  helperInRootExports: false,
  allPassed: true,
};
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ receipt, observations: results }, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
