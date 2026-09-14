/** README comparison: preserve the original operation groups and reference types. */
import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { Map as ImmutableMap, OrderedMap as ImmutableOrderedMap, List as ImmutableList, Stack as ImmutableStack } from 'immutable';
import { SharedMap, SharedList, SharedStack, SharedQueue, SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap, SharedSortedMap } from '../shared';
import { resetMap } from '../shared-map';
import { resetSharedList } from '../shared-list';
import { resetStack } from '../shared-stack';
import { resetQueue } from '../shared-queue';
import { resetLinkedList } from '../shared-linked-list';
import { resetDoublyLinkedList } from '../shared-doubly-linked-list';
import { resetOrderedMap } from '../shared-ordered-map';
import { resetSortedMap } from '../shared-sorted-map';

const N = Number(process.env.N ?? 10000);
assert(Number.isInteger(N) && N >= 1000 && N <= 100000);
const includeArenaSetup = process.env.INCLUDE_ARENA_SETUP !== '0';
const samples = Number(process.env.SAMPLES ?? 15), warmups = 10;
const round = Number(process.env.ROUND ?? 1);
assert(Number.isInteger(samples) && samples > 0 && samples <= 100);
assert(Number.isInteger(round) && round >= 1 && round <= 3);
const kinds = ['shared', 'immutable', 'native'] as const;
type Kind = typeof kinds[number];
type Case = { group: string; operation: string; count: number; repeat: number; kind: Kind; setup(): void; run(): any; check(result: any): void; checkBase(): void };
const cases: Case[] = [];
const numbers = Array.from({ length: N }, (_, i) => i);
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const sortedKeys = numbers.map(i => `key${String(i).padStart(5, '0')}`);
const shuffledKeys = [...sortedKeys];
let seed = 0x13579bdf;
for (let i = N - 1; i > 0; i--) {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  const j = (seed >>> 0) % (i + 1);
  [shuffledKeys[i], shuffledKeys[j]] = [shuffledKeys[j], shuffledKeys[i]];
}

function mapCases(group: string, sharedClass: any, reset: () => void, immutableFactory: any, sorted = false) {
  const keys = sorted ? shuffledKeys : numbers.map(i => `key${i}`);
  const queryKeys = sorted ? sortedKeys : keys;
  const values = sorted ? numbers : numbers.map(i => `val${i}`);
  const expected = keys.map((key, i) => [key, values[i]]);
  const entries = (value: any) => [...value.entries()];
  const canonical = (value: any) => entries(value).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const checkMap = (actual: any, expectedEntries: any[]) => {
    assert.equal(actual.size, expectedEntries.length);
    assert.deepEqual(canonical(actual), [...expectedEntries].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (group === 'SharedOrderedMap') assert.deepEqual(entries(actual), expectedEntries);
  };
  const operations = group === 'SharedMap' ? ['set', 'get', 'has', 'delete', 'setMany(100)'] : sorted ? ['set', 'get', 'has', 'delete', 'keys(sorted)'] : ['set', 'get', 'has', 'delete', 'forEach'];
  for (const operation of operations) for (const kind of kinds) {
    if (kind === 'immutable' && !immutableFactory) continue;
    let base: any;
    const empty = () => kind === 'shared' ? new sharedClass(sorted ? 'number' : 'string') : kind === 'immutable' ? immutableFactory() : new Map();
    const build = () => { let value = empty(); for (let i = 0; i < N; i++) value = value.set(keys[i], values[i]); return value; };
    const isBuild = operation === 'set';
    const changed = operation === 'setMany(100)' ? expected.map(([k, v], i) => [k, i < 100 ? `new${i}` : v]) : expected.filter(([k]) => !queryKeys.slice(0, 10).includes(k as string));
    const batch = keys.slice(0, 100).map((k, i) => [k, `new${i}`]);
    cases.push({ group, operation, kind, count: operation === 'delete' ? 10 : operation === 'setMany(100)' ? 100 : N, repeat: isBuild ? 1 : 20,
      setup() { if (kind === 'shared') reset(); if (!isBuild) { base = build(); checkMap(base, expected); } },
      run() {
        if (isBuild) { if (kind === 'shared' && includeArenaSetup) reset(); return build(); }
        if (operation === 'get') { let total = 0; for (const key of queryKeys) { const v = base.get(key); total += sorted ? v : v.length; } return total; }
        if (operation === 'has') { let total = 0; for (const key of queryKeys) total += Number(base.has(key)); return total; }
        if (operation === 'forEach') { let total = 0; base.forEach(() => { total++; }); return total; }
        if (operation === 'keys(sorted)') return kind === 'native' ? [...base.keys()].sort() : [...base.keys()];
        let value = kind === 'native' ? new Map(base) : base;
        if (operation === 'delete') { for (let i = 0; i < 10; i++) { if (kind === 'native') value.delete(queryKeys[i]); else value = value.delete(queryKeys[i]); } }
        else if (kind === 'shared') value = value.setMany(batch);
        else for (const [k, v] of batch) value = value.set(k, v);
        return value;
      },
      check(value) {
        if (isBuild) checkMap(value, expected);
        else if (operation === 'get') assert.equal(value, sorted ? sum(numbers) : (values as string[]).reduce((n, s) => n + s.length, 0));
        else if (operation === 'has' || operation === 'forEach') assert.equal(value, N);
        else if (operation === 'keys(sorted)') assert.deepEqual(value, sortedKeys);
        else checkMap(value, changed);
      },
      checkBase() { if (!isBuild) checkMap(base, expected); base = undefined; }
    });
  }
}
mapCases('SharedMap', SharedMap, resetMap, ImmutableMap);

function sequenceCases(group: string, sharedClass: any, reset: () => void, immutableFactory: any, operations: string[], append: string) {
  for (const operation of operations) for (const kind of kinds) {
    if (kind === 'immutable' && !immutableFactory) continue;
    let base: any;
    const isStack = group === 'SharedStack';
    const original = isStack ? [...numbers].reverse() : numbers;
    const empty = () => kind === 'shared' ? new sharedClass('number') : kind === 'immutable' ? immutableFactory() : [];
    const list = (value: any) => {
      if (kind === 'native') return isStack ? [...value].reverse() : value;
      if (kind === 'shared' && (isStack || group === 'SharedQueue')) {
        const output: number[] = [], length = value.size;
        for (let i = 0; i < length; i++) { output.push(value.peek()); value = isStack ? value.pop() : value.dequeue(); }
        assert.equal(value.size, 0); return output;
      }
      return value.toArray();
    };
    const checkSequence = (value: any, target: number[]) => assert.deepEqual(list(value), target);
    const build = (prepend = false) => {
      let value = empty();
      for (let i = 0; i < N; i++) {
        if (kind === 'native') { if (prepend) value.unshift(i); else value.push(i); }
        else value = value[prepend ? 'prepend' : kind === 'immutable' ? 'push' : append](i);
      }
      return value;
    };
    const isBuild = operation === append || operation === 'prepend';
    const isPeek = operation === 'peek';
    const readStart = operation === 'get(back)' ? N - 50 : 0;
    const readCount = operation === 'get(0-99)' ? 100 : operation.startsWith('get(') ? 50 : N;
    const count = isBuild || isPeek || operation === 'forEach' ? N : operation.startsWith('get') ? readCount : operation === 'enq+deq(100)' ? 100 : 10;
    cases.push({ group, operation, count, kind, repeat: isBuild ? 1 : 20,
      setup() { if (kind === 'shared') reset(); if (!isBuild) { base = build(); checkSequence(base, original); } },
      run() {
        if (isBuild) { if (kind === 'shared' && includeArenaSetup) reset(); return build(operation === 'prepend'); }
        if (operation.startsWith('get')) { let total = 0; for (let i = readStart; i < readStart + readCount; i++) total += kind === 'native' ? base[i] : base.get(i); return total; }
        if (isPeek) { let total = 0; for (let i = 0; i < N; i++) total += kind === 'native' ? base[isStack ? N - 1 : 0] : base.peek(); return total; }
        if (operation === 'forEach') { let total = 0; base.forEach((v: number) => { total += v; }); return total; }
        let value = kind === 'native' ? [...base] : base;
        if (operation === 'enq+deq(100)') for (let i = 0; i < 100; i++) {
          if (kind === 'native') { value.push(i); value.shift(); } else value = value.enqueue(i).dequeue();
        }
        else for (let i = 0; i < 10; i++) {
          if (kind === 'native') { if (operation === 'pop' || operation === 'removeLast') value.pop(); else value.shift(); }
          else value = value[operation]();
        }
        return value;
      },
      check(value) {
        if (isBuild) checkSequence(value, operation === 'prepend' ? [...numbers].reverse() : original);
        else if (operation.startsWith('get')) assert.equal(value, sum(numbers.slice(readStart, readStart + readCount)));
        else if (isPeek) assert.equal(value, isStack ? N * (N - 1) : 0);
        else if (operation === 'forEach') assert.equal(value, sum(numbers));
        else if (operation === 'enq+deq(100)') checkSequence(value, numbers.slice(100).concat(numbers.slice(0, 100)));
        else checkSequence(value, isStack || operation === 'dequeue' || operation === 'removeFirst' ? original.slice(10) : original.slice(0, -10));
      },
      checkBase() { if (!isBuild) checkSequence(base, original); base = undefined; }
    });
  }
}
sequenceCases('SharedList', SharedList, resetSharedList, ImmutableList, ['push', 'get', 'pop', 'forEach'], 'push');
sequenceCases('SharedStack', SharedStack, resetStack, ImmutableStack, ['push', 'peek', 'pop'], 'push');
sequenceCases('SharedQueue', SharedQueue, resetQueue, null, ['enqueue', 'peek', 'dequeue', 'enq+deq(100)'], 'enqueue');
sequenceCases('SharedLinkedList', SharedLinkedList, resetLinkedList, null, ['prepend', 'append', 'get(0-99)', 'removeFirst'], 'append');
sequenceCases('SharedDoublyLinkedList', SharedDoublyLinkedList, resetDoublyLinkedList, null, ['prepend', 'append', 'get(front)', 'get(back)', 'removeFirst', 'removeLast'], 'append');
mapCases('SharedOrderedMap', SharedOrderedMap, resetOrderedMap, ImmutableOrderedMap);
mapCases('SharedSortedMap', SharedSortedMap, resetSortedMap, null, true);

const rows: any[] = [];
const sink = { value: undefined as any };
// Observable return values prevent the unused read expressions in benchmark.ts.
Object.defineProperty(globalThis, '__zerocopyReadmeBenchmarkSink', { value: sink, configurable: true });
const rowKeys = [...new Set(cases.map(c => `${c.group}:${c.operation}`))].filter(key => !process.env.CASE_FILTER || process.env.CASE_FILTER.split(',').includes(key));
for (const key of rowKeys) {
  const variants = cases.filter(c => `${c.group}:${c.operation}` === key);
  const rotation = (round - 1) % variants.length;
  for (let index = 0; index < variants.length; index++) {
    const c = variants[(index + rotation) % variants.length];
    c.setup();
    for (let w = 0; w < warmups; w++) { if (!includeArenaSetup && c.kind === 'shared' && c.repeat === 1) c.setup(); sink.value = c.run(); c.check(sink.value); }
    const times: number[] = [];
    for (let s = 0; s < samples; s++) {
      if (!includeArenaSetup && c.kind === 'shared' && c.repeat === 1) c.setup();
      const start = performance.now();
      for (let i = 0; i < c.repeat; i++) sink.value = c.run();
      times.push((performance.now() - start) / c.repeat);
      c.check(sink.value);
    }
    c.checkBase();
    rows.push({ group: c.group, operation: c.operation, kind: c.kind, operationsPerWorkload: c.count, workloadsPerSample: c.repeat, samplesMs: times });
    sink.value = undefined;
    Bun.gc(true);
    console.error(`${round}: ${c.group} ${c.operation} ${c.kind} checked`);
  }
}
const root = new URL('../', import.meta.url);
const engineFiles = readdirSync(root).filter(f => /^(arena|read-cache|codec|compaction|set-key|types|utf8|wasm-utils|shared.*|persistent-core\.as)\.ts$/.test(f) && !f.endsWith('.test.ts')).sort();
const hash = createHash('sha256');
for (const file of engineFiles) hash.update(file + '\0').update(readFileSync(new URL(file, root))).update('\0');
const result = { schema: 1, sourceCommit: process.env.SOURCE_COMMIT ?? 'uncommitted; use engineSHA256', measuredAt: new Date().toISOString(), round, N, warmups, includeArenaSetup, caseFilter: process.env.CASE_FILTER ?? null,
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, cpu: cpus()[0].model, immutable: JSON.parse(readFileSync(new URL('node_modules/immutable/package.json', root), 'utf8')).version, assemblyscript: JSON.parse(readFileSync(new URL('node_modules/assemblyscript/package.json', root), 'utf8')).version },
  engineFiles, engineSHA256: hash.digest('hex'), wasmSHA256: createHash('sha256').update(readFileSync(new URL('persistent-core.wasm', root))).digest('hex'), benchmarkSHA256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), rows };
const output = process.argv[2] ?? `proofs/results/readme-libraries-round-${round}.json`;
mkdirSync(new URL('proofs/results/', root), { recursive: true });
writeFileSync(output, JSON.stringify(result) + '\n');
console.log(`Saved ${rows.length} validated variants to ${output}`);
