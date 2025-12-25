import { Set as ImmutableSet, List as ImmutableList, Map as ImmutableMap, Stack as ImmutableStack, OrderedMap as ImmutableOrderedMap, OrderedSet as ImmutableOrderedSet, SortedMap as ImmutableSortedMap, SortedSet as ImmutableSortedSet } from 'immutable';
import { SharedSet } from './shared-set';
import { SharedStack, resetStack } from './shared-stack';
import { SharedQueue, resetQueue } from './shared-queue';
import { SharedList, resetSharedList } from './shared-list';
import { SharedMap, resetMap, configureAutoGC, getUsedBytes } from './shared-map';
import { SharedLinkedList, resetLinkedList } from './shared-linked-list';
import { SharedDoublyLinkedList, resetDoublyLinkedList } from './shared-doubly-linked-list';
import { SharedOrderedMap, resetOrderedMap } from './shared-ordered-map';
import { SharedOrderedSet, resetOrderedSet } from './shared-ordered-set';
import { SharedSortedMap, resetSortedMap } from './shared-sorted-map';
import { SharedSortedSet, resetSortedSet } from './shared-sorted-set';
import { SharedPriorityQueue, resetPriorityQueue } from './shared-priority-queue';

function bench(fn: () => void, iterations: number): number {
  for (let i = 0; i < Math.min(50, iterations); i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return (performance.now() - start) / iterations;
}

function printRow(op: string, hamtMs: number, immMs: number, nativeMs?: number) {
  const ratio = hamtMs < immMs ? `${(immMs/hamtMs).toFixed(2)}x faster` : `${(hamtMs/immMs).toFixed(2)}x slower`;
  let row = `${op.padEnd(14)} │ ${hamtMs.toFixed(4).padStart(9)} │ ${immMs.toFixed(4).padStart(8)} │ ${ratio.padEnd(14)}`;
  if (nativeMs !== undefined) {
    const nRatio = hamtMs < nativeMs ? `${(nativeMs/hamtMs).toFixed(2)}x faster` : `${(hamtMs/nativeMs).toFixed(2)}x slower`;
    row += ` │ ${nativeMs.toFixed(4).padStart(8)} │ ${nRatio}`;
  }
  console.log(row);
}

function header3() {
  console.log('Operation       │ Shared (ms) │ Imm (ms) │ vs Imm         │ Nat (ms) │ vs Native');
  console.log('────────────────┼─────────────┼──────────┼────────────────┼──────────┼──────────');
}

function header2() {
  console.log('Operation       │ Shared (ms) │ Nat (ms) │ vs Native');
  console.log('────────────────┼─────────────┼──────────┼──────────');
}

async function benchSharedMap() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SharedMap vs Immutable.Map vs Native Map`);
  console.log(`${'='.repeat(80)}`);
  configureAutoGC({ enabled: false });

  for (const N of [100, 1000, 10000]) {
    const iterations = Math.max(50, Math.floor(10000 / N));
    const keys = Array.from({ length: N }, (_, i) => `key${i}`);
    const vals = Array.from({ length: N }, (_, i) => `val${i}`);

    console.log(`\n--- N=${N} (${iterations} iterations) ---`);
    header3();

    // set
    printRow('set',
      bench(() => { resetMap(); let m = new SharedMap('string'); for (let i = 0; i < N; i++) m = m.set(keys[i], vals[i]); }, iterations),
      bench(() => { let m = ImmutableMap<string,string>(); for (let i = 0; i < N; i++) m = m.set(keys[i], vals[i]); }, iterations),
      bench(() => { const m = new Map(); for (let i = 0; i < N; i++) m.set(keys[i], vals[i]); }, iterations));

    resetMap();
    let h = new SharedMap('string'); for (let i = 0; i < N; i++) h = h.set(keys[i], vals[i]);
    let im = ImmutableMap<string,string>(); for (let i = 0; i < N; i++) im = im.set(keys[i], vals[i]);
    const nm = new Map(keys.map((k,i) => [k, vals[i]]));

    // get
    printRow('get',
      bench(() => { for (const k of keys) h.get(k); }, iterations),
      bench(() => { for (const k of keys) im.get(k); }, iterations),
      bench(() => { for (const k of keys) nm.get(k); }, iterations));

    // has
    printRow('has',
      bench(() => { for (const k of keys) h.has(k); }, iterations),
      bench(() => { for (const k of keys) im.has(k); }, iterations),
      bench(() => { for (const k of keys) nm.has(k); }, iterations));

    // delete
    printRow('delete',
      bench(() => { let x = h; for (let i = 0; i < 10; i++) x = x.delete(keys[i]); }, iterations),
      bench(() => { let x = im; for (let i = 0; i < 10; i++) x = x.delete(keys[i]); }, iterations),
      bench(() => { const x = new Map(nm); for (let i = 0; i < 10; i++) x.delete(keys[i]); }, iterations));

    // setMany (batch)
    const batchEntries: [string, string][] = keys.slice(0, 100).map((k, i) => [k, `new${i}`]);
    printRow('setMany(100)',
      bench(() => { h.setMany(batchEntries); }, iterations),
      bench(() => { let x = im; for (const [k, v] of batchEntries) x = x.set(k, v); }, iterations),
      bench(() => { const x = new Map(nm); for (const [k, v] of batchEntries) x.set(k, v); }, iterations));

    // getMany (batch)
    const batchKeys = keys.slice(0, 100);
    printRow('getMany(100)',
      bench(() => { h.getMany(batchKeys); }, iterations),
      bench(() => { batchKeys.map(k => im.get(k)); }, iterations),
      bench(() => { batchKeys.map(k => nm.get(k)); }, iterations));

    // iteration
    printRow('forEach',
      bench(() => { let c = 0; h.forEach(() => c++); }, iterations),
      bench(() => { let c = 0; im.forEach(() => c++); }, iterations),
      bench(() => { let c = 0; nm.forEach(() => c++); }, iterations));

    // Memory usage
    console.log(`Memory: ${(getUsedBytes() / 1024).toFixed(1)} KB`);
  }
}

async function benchSet() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SharedSet vs Immutable.Set vs Native Set`);
  console.log(`${'='.repeat(80)}`);

  for (const N of [100, 1000, 10000]) {
    const iterations = Math.max(50, Math.floor(10000 / N));
    const values = Array.from({ length: N }, (_, i) => `item${i}`);

    console.log(`\n--- N=${N} (${iterations} iterations) ---`);
    header3();

    printRow('add',
      bench(() => { resetMap(); let s = new SharedSet(); for (const v of values) s = s.add(v); }, iterations),
      bench(() => { let s = ImmutableSet<string>(); for (const v of values) s = s.add(v); }, iterations),
      bench(() => { const s = new Set(); for (const v of values) s.add(v); }, iterations));

    resetMap();
    let hs = new SharedSet<string>(); for (const v of values) hs = hs.add(v);
    let is = ImmutableSet<string>(); for (const v of values) is = is.add(v);
    const ns = new Set(values);

    printRow('has',
      bench(() => { for (const v of values) hs.has(v); }, iterations),
      bench(() => { for (const v of values) is.has(v); }, iterations),
      bench(() => { for (const v of values) ns.has(v); }, iterations));

    printRow('delete',
      bench(() => { let s = hs; for (let i = 0; i < 10; i++) s = s.delete(values[i]); }, iterations),
      bench(() => { let s = is; for (let i = 0; i < 10; i++) s = s.delete(values[i]); }, iterations),
      bench(() => { const s = new Set(ns); for (let i = 0; i < 10; i++) s.delete(values[i]); }, iterations));

    // addMany (batch)
    const batchVals = values.slice(0, 100);
    printRow('addMany(100)',
      bench(() => { hs.addMany(batchVals); }, iterations),
      bench(() => { let s = is; for (const v of batchVals) s = s.add(v); }, iterations),
      bench(() => { const s = new Set(ns); for (const v of batchVals) s.add(v); }, iterations));

    printRow('forEach',
      bench(() => { let c = 0; hs.forEach(() => c++); }, iterations),
      bench(() => { let c = 0; is.forEach(() => c++); }, iterations),
      bench(() => { let c = 0; ns.forEach(() => c++); }, iterations));
  }
}

async function benchList() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SharedList vs Immutable.List vs Native Array`);
  console.log(`${'='.repeat(80)}`);

  for (const N of [100, 1000, 10000]) {
    resetSharedList();
    const iterations = Math.max(50, Math.floor(10000 / N));

    console.log(`\n--- N=${N} (${iterations} iterations) ---`);
    header3();

    printRow('push',
      bench(() => { resetSharedList(); let v = new SharedList('number'); for (let i = 0; i < N; i++) v = v.push(i); }, iterations),
      bench(() => { let l = ImmutableList<number>(); for (let i = 0; i < N; i++) l = l.push(i); }, iterations),
      bench(() => { const a: number[] = []; for (let i = 0; i < N; i++) a.push(i); }, iterations));

    resetSharedList();
    let vec = new SharedList('number'); for (let i = 0; i < N; i++) vec = vec.push(i);
    let il = ImmutableList<number>(); for (let i = 0; i < N; i++) il = il.push(i);
    const na = Array.from({ length: N }, (_, i) => i);

    printRow('get',
      bench(() => { for (let i = 0; i < N; i++) vec.get(i); }, iterations),
      bench(() => { for (let i = 0; i < N; i++) il.get(i); }, iterations),
      bench(() => { for (let i = 0; i < N; i++) na[i]; }, iterations));

    printRow('get(random)',
      bench(() => { for (let i = 0; i < N; i++) vec.get((i * 7) % N); }, iterations),
      bench(() => { for (let i = 0; i < N; i++) il.get((i * 7) % N); }, iterations),
      bench(() => { for (let i = 0; i < N; i++) na[(i * 7) % N]; }, iterations));

    printRow('set',
      bench(() => { let v = vec; for (let i = 0; i < 10; i++) v = v.set(i, 99); }, iterations),
      bench(() => { let l = il; for (let i = 0; i < 10; i++) l = l.set(i, 99); }, iterations),
      bench(() => { const a = [...na]; for (let i = 0; i < 10; i++) a[i] = 99; }, iterations));

    printRow('pop',
      bench(() => { let v = vec; for (let i = 0; i < 10; i++) v = v.pop(); }, iterations),
      bench(() => { let l = il; for (let i = 0; i < 10; i++) l = l.pop(); }, iterations),
      bench(() => { const a = [...na]; for (let i = 0; i < 10; i++) a.pop(); }, iterations));

    printRow('forEach',
      bench(() => { let s = 0; vec.forEach(v => s += v); }, iterations),
      bench(() => { let s = 0; il.forEach(v => s += v); }, iterations),
      bench(() => { let s = 0; na.forEach(v => s += v); }, iterations));

    printRow('toArray',
      bench(() => { vec.toArray(); }, iterations),
      bench(() => { il.toArray(); }, iterations),
      bench(() => { [...na]; }, iterations));
  }
}

async function benchStack() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SharedStack vs Immutable.Stack vs Native Array`);
  console.log(`${'='.repeat(80)}`);

  for (const N of [100, 1000, 10000]) {
    resetStack();
    const iterations = Math.max(50, Math.floor(10000 / N));

    console.log(`\n--- N=${N} (${iterations} iterations) ---`);
    header3();

    printRow('push',
      bench(() => { resetStack(); let s = new SharedStack('number'); for (let i = 0; i < N; i++) s = s.push(i); }, iterations),
      bench(() => { let s = ImmutableStack<number>(); for (let i = 0; i < N; i++) s = s.push(i); }, iterations),
      bench(() => { const a: number[] = []; for (let i = 0; i < N; i++) a.push(i); }, iterations));

    resetStack();
    let hs = new SharedStack('number'); for (let i = 0; i < N; i++) hs = hs.push(i);
    let is = ImmutableStack<number>(); for (let i = 0; i < N; i++) is = is.push(i);
    const na = Array.from({ length: N }, (_, i) => i);

    printRow('peek',
      bench(() => { for (let i = 0; i < N; i++) hs.peek(); }, iterations),
      bench(() => { for (let i = 0; i < N; i++) is.peek(); }, iterations),
      bench(() => { for (let i = 0; i < N; i++) na[na.length - 1]; }, iterations));

    printRow('pop',
      bench(() => { let s = hs; for (let i = 0; i < 10; i++) s = s.pop(); }, iterations),
      bench(() => { let s = is; for (let i = 0; i < 10; i++) s = s.pop(); }, iterations),
      bench(() => { const a = [...na]; for (let i = 0; i < 10; i++) a.pop(); }, iterations));

    printRow('push+pop(100)',
      bench(() => { let s = hs; for (let i = 0; i < 100; i++) { s = s.push(i); s = s.pop(); } }, iterations),
      bench(() => { let s = is; for (let i = 0; i < 100; i++) { s = s.push(i); s = s.pop(); } }, iterations),
      bench(() => { const a = [...na]; for (let i = 0; i < 100; i++) { a.push(i); a.pop(); } }, iterations));
  }
}

async function benchQueue() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SharedQueue vs Native Array (shift is O(n))`);
  console.log(`${'='.repeat(80)}`);

  for (const N of [100, 1000, 10000]) {
    resetQueue();
    const iterations = Math.max(50, Math.floor(10000 / N));

    console.log(`\n--- N=${N} (${iterations} iterations) ---`);
    header2();

    const hqEnq = bench(() => { resetQueue(); let q = new SharedQueue('number'); for (let i = 0; i < N; i++) q = q.enqueue(i); }, iterations);
    const naEnq = bench(() => { const a: number[] = []; for (let i = 0; i < N; i++) a.push(i); }, iterations);
    console.log(`${'enqueue'.padEnd(14)} │ ${hqEnq.toFixed(4).padStart(11)} │ ${naEnq.toFixed(4).padStart(8)} │ ${hqEnq < naEnq ? `${(naEnq/hqEnq).toFixed(2)}x faster` : `${(hqEnq/naEnq).toFixed(2)}x slower`}`);

    resetQueue();
    let hq = new SharedQueue('number'); for (let i = 0; i < N; i++) hq = hq.enqueue(i);
    const na = Array.from({ length: N }, (_, i) => i);

    const hqPeek = bench(() => { for (let i = 0; i < N; i++) hq.peek(); }, iterations);
    const naPeek = bench(() => { for (let i = 0; i < N; i++) na[0]; }, iterations);
    console.log(`${'peek'.padEnd(14)} │ ${hqPeek.toFixed(4).padStart(11)} │ ${naPeek.toFixed(4).padStart(8)} │ ${hqPeek < naPeek ? `${(naPeek/hqPeek).toFixed(2)}x faster` : `${(hqPeek/naPeek).toFixed(2)}x slower`}`);

    const hqDeq = bench(() => { let q = hq; for (let i = 0; i < 10; i++) q = q.dequeue(); }, iterations);
    const naDeq = bench(() => { const a = [...na]; for (let i = 0; i < 10; i++) a.shift(); }, iterations);
    console.log(`${'dequeue'.padEnd(14)} │ ${hqDeq.toFixed(4).padStart(11)} │ ${naDeq.toFixed(4).padStart(8)} │ ${hqDeq < naDeq ? `${(naDeq/hqDeq).toFixed(2)}x faster` : `${(hqDeq/naDeq).toFixed(2)}x slower`}`);

    // enqueue+dequeue cycle
    const hqCycle = bench(() => { let q = hq; for (let i = 0; i < 100; i++) { q = q.enqueue(i); q = q.dequeue(); } }, iterations);
    const naCycle = bench(() => { const a = [...na]; for (let i = 0; i < 100; i++) { a.push(i); a.shift(); } }, iterations);
    console.log(`${'enq+deq(100)'.padEnd(14)} │ ${hqCycle.toFixed(4).padStart(11)} │ ${naCycle.toFixed(4).padStart(8)} │ ${hqCycle < naCycle ? `${(naCycle/hqCycle).toFixed(2)}x faster` : `${(hqCycle/naCycle).toFixed(2)}x slower`}`);
  }
}

async function benchStringTypes() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`String Value Type Performance`);
  console.log(`${'='.repeat(80)}`);

  const N = 1000;
  const iterations = 50;
  const strings = Array.from({ length: N }, (_, i) => `string_value_${i}_with_some_extra_content`);

  console.log(`\n--- SharedMap<string> vs SharedMap<number> (N=${N}) ---`);
  
  const strTime = bench(() => { resetMap(); let m = new SharedMap('string'); for (let i = 0; i < N; i++) m = m.set(`k${i}`, strings[i]); }, iterations);
  const numTime = bench(() => { resetMap(); let m = new SharedMap('number'); for (let i = 0; i < N; i++) m = m.set(`k${i}`, i); }, iterations);
  console.log(`set(string): ${strTime.toFixed(4)}ms, set(number): ${numTime.toFixed(4)}ms, ratio: ${(strTime/numTime).toFixed(2)}x`);

  // Build maps for get benchmark (don't reset between builds)
  resetMap();
  let strMap = new SharedMap('string'); for (let i = 0; i < N; i++) strMap = strMap.set(`k${i}`, strings[i]);
  let numMap = new SharedMap('number'); for (let i = 0; i < N; i++) numMap = numMap.set(`k${i}`, i);

  const strGetTime = bench(() => { for (let i = 0; i < N; i++) strMap.get(`k${i}`); }, iterations);
  const numGetTime = bench(() => { for (let i = 0; i < N; i++) numMap.get(`k${i}`); }, iterations);
  console.log(`get(string): ${strGetTime.toFixed(4)}ms, get(number): ${numGetTime.toFixed(4)}ms, ratio: ${(strGetTime/numGetTime).toFixed(2)}x`);
}

async function benchLinkedList() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SharedLinkedList vs Native Array`);
  console.log(`${'='.repeat(80)}`);

  for (const N of [100, 1000, 10000]) {
    resetLinkedList();
    const iterations = Math.max(50, Math.floor(10000 / N));

    console.log(`\n--- N=${N} (${iterations} iterations) ---`);
    header2();

    const llPrepend = bench(() => { resetLinkedList(); let l = new SharedLinkedList('number'); for (let i = 0; i < N; i++) l = l.prepend(i); }, iterations);
    const naPrepend = bench(() => { const a: number[] = []; for (let i = 0; i < N; i++) a.unshift(i); }, iterations);
    console.log(`${'prepend'.padEnd(14)} │ ${llPrepend.toFixed(4).padStart(11)} │ ${naPrepend.toFixed(4).padStart(8)} │ ${llPrepend < naPrepend ? `${(naPrepend/llPrepend).toFixed(2)}x faster` : `${(llPrepend/naPrepend).toFixed(2)}x slower`}`);

    const llAppend = bench(() => { resetLinkedList(); let l = new SharedLinkedList('number'); for (let i = 0; i < N; i++) l = l.append(i); }, iterations);
    const naAppend = bench(() => { const a: number[] = []; for (let i = 0; i < N; i++) a.push(i); }, iterations);
    console.log(`${'append'.padEnd(14)} │ ${llAppend.toFixed(4).padStart(11)} │ ${naAppend.toFixed(4).padStart(8)} │ ${llAppend < naAppend ? `${(naAppend/llAppend).toFixed(2)}x faster` : `${(llAppend/naAppend).toFixed(2)}x slower`}`);

    resetLinkedList();
    let ll = new SharedLinkedList('number'); for (let i = 0; i < N; i++) ll = ll.append(i);
    const na = Array.from({ length: N }, (_, i) => i);

    const llGet = bench(() => { for (let i = 0; i < Math.min(100, N); i++) ll.get(i); }, iterations);
    const naGet = bench(() => { for (let i = 0; i < Math.min(100, N); i++) na[i]; }, iterations);
    console.log(`${'get(0-99)'.padEnd(14)} │ ${llGet.toFixed(4).padStart(11)} │ ${naGet.toFixed(4).padStart(8)} │ ${llGet < naGet ? `${(naGet/llGet).toFixed(2)}x faster` : `${(llGet/naGet).toFixed(2)}x slower`}`);

    const llRemove = bench(() => { let l = ll; for (let i = 0; i < 10; i++) l = l.removeFirst(); }, iterations);
    const naRemove = bench(() => { const a = [...na]; for (let i = 0; i < 10; i++) a.shift(); }, iterations);
    console.log(`${'removeFirst'.padEnd(14)} │ ${llRemove.toFixed(4).padStart(11)} │ ${naRemove.toFixed(4).padStart(8)} │ ${llRemove < naRemove ? `${(naRemove/llRemove).toFixed(2)}x faster` : `${(llRemove/naRemove).toFixed(2)}x slower`}`);
  }
}

async function benchDoublyLinkedList() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SharedDoublyLinkedList vs Native Array`);
  console.log(`${'='.repeat(80)}`);

  for (const N of [100, 1000, 10000]) {
    resetDoublyLinkedList();
    const iterations = Math.max(50, Math.floor(10000 / N));

    console.log(`\n--- N=${N} (${iterations} iterations) ---`);
    header2();

    const dllPrepend = bench(() => { resetDoublyLinkedList(); let l = new SharedDoublyLinkedList('number'); for (let i = 0; i < N; i++) l = l.prepend(i); }, iterations);
    const naPrepend = bench(() => { const a: number[] = []; for (let i = 0; i < N; i++) a.unshift(i); }, iterations);
    console.log(`${'prepend'.padEnd(14)} │ ${dllPrepend.toFixed(4).padStart(11)} │ ${naPrepend.toFixed(4).padStart(8)} │ ${dllPrepend < naPrepend ? `${(naPrepend/dllPrepend).toFixed(2)}x faster` : `${(dllPrepend/naPrepend).toFixed(2)}x slower`}`);

    const dllAppend = bench(() => { resetDoublyLinkedList(); let l = new SharedDoublyLinkedList('number'); for (let i = 0; i < N; i++) l = l.append(i); }, iterations);
    const naAppend = bench(() => { const a: number[] = []; for (let i = 0; i < N; i++) a.push(i); }, iterations);
    console.log(`${'append'.padEnd(14)} │ ${dllAppend.toFixed(4).padStart(11)} │ ${naAppend.toFixed(4).padStart(8)} │ ${dllAppend < naAppend ? `${(naAppend/dllAppend).toFixed(2)}x faster` : `${(dllAppend/naAppend).toFixed(2)}x slower`}`);

    resetDoublyLinkedList();
    let dll = new SharedDoublyLinkedList('number'); for (let i = 0; i < N; i++) dll = dll.append(i);
    const na = Array.from({ length: N }, (_, i) => i);

    const dllGetFront = bench(() => { for (let i = 0; i < Math.min(50, N); i++) dll.get(i); }, iterations);
    const naGetFront = bench(() => { for (let i = 0; i < Math.min(50, N); i++) na[i]; }, iterations);
    console.log(`${'get(front)'.padEnd(14)} │ ${dllGetFront.toFixed(4).padStart(11)} │ ${naGetFront.toFixed(4).padStart(8)} │ ${dllGetFront < naGetFront ? `${(naGetFront/dllGetFront).toFixed(2)}x faster` : `${(dllGetFront/naGetFront).toFixed(2)}x slower`}`);

    const dllGetBack = bench(() => { for (let i = N - 50; i < N; i++) dll.get(i); }, iterations);
    const naGetBack = bench(() => { for (let i = N - 50; i < N; i++) na[i]; }, iterations);
    console.log(`${'get(back)'.padEnd(14)} │ ${dllGetBack.toFixed(4).padStart(11)} │ ${naGetBack.toFixed(4).padStart(8)} │ ${dllGetBack < naGetBack ? `${(naGetBack/dllGetBack).toFixed(2)}x faster` : `${(dllGetBack/naGetBack).toFixed(2)}x slower`}`);

    const dllRemoveFirst = bench(() => { let l = dll; for (let i = 0; i < 10; i++) l = l.removeFirst(); }, iterations);
    const naRemoveFirst = bench(() => { const a = [...na]; for (let i = 0; i < 10; i++) a.shift(); }, iterations);
    console.log(`${'removeFirst'.padEnd(14)} │ ${dllRemoveFirst.toFixed(4).padStart(11)} │ ${naRemoveFirst.toFixed(4).padStart(8)} │ ${dllRemoveFirst < naRemoveFirst ? `${(naRemoveFirst/dllRemoveFirst).toFixed(2)}x faster` : `${(dllRemoveFirst/naRemoveFirst).toFixed(2)}x slower`}`);

    const dllRemoveLast = bench(() => { let l = dll; for (let i = 0; i < 10; i++) l = l.removeLast(); }, iterations);
    const naRemoveLast = bench(() => { const a = [...na]; for (let i = 0; i < 10; i++) a.pop(); }, iterations);
    console.log(`${'removeLast'.padEnd(14)} │ ${dllRemoveLast.toFixed(4).padStart(11)} │ ${naRemoveLast.toFixed(4).padStart(8)} │ ${dllRemoveLast < naRemoveLast ? `${(naRemoveLast/dllRemoveLast).toFixed(2)}x faster` : `${(dllRemoveLast/naRemoveLast).toFixed(2)}x slower`}`);
  }
}

async function benchOrderedMap() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SharedOrderedMap vs Immutable.OrderedMap vs Native Map`);
  console.log(`${'='.repeat(80)}`);

  for (const N of [100, 1000, 10000]) {
    resetOrderedMap();
    const iterations = Math.max(50, Math.floor(10000 / N));
    const keys = Array.from({ length: N }, (_, i) => `key${i}`);
    const vals = Array.from({ length: N }, (_, i) => `val${i}`);

    console.log(`\n--- N=${N} (${iterations} iterations) ---`);
    header3();

    printRow('set',
      bench(() => { resetOrderedMap(); let m = new SharedOrderedMap('string'); for (let i = 0; i < N; i++) m = m.set(keys[i], vals[i]); }, iterations),
      bench(() => { let m = ImmutableOrderedMap<string,string>(); for (let i = 0; i < N; i++) m = m.set(keys[i], vals[i]); }, iterations),
      bench(() => { const m = new Map(); for (let i = 0; i < N; i++) m.set(keys[i], vals[i]); }, iterations));

    resetOrderedMap();
    let om = new SharedOrderedMap('string'); for (let i = 0; i < N; i++) om = om.set(keys[i], vals[i]);
    let iom = ImmutableOrderedMap<string,string>(); for (let i = 0; i < N; i++) iom = iom.set(keys[i], vals[i]);
    const nm = new Map(keys.map((k,i) => [k, vals[i]]));

    printRow('get',
      bench(() => { for (const k of keys) om.get(k); }, iterations),
      bench(() => { for (const k of keys) iom.get(k); }, iterations),
      bench(() => { for (const k of keys) nm.get(k); }, iterations));

    printRow('has',
      bench(() => { for (const k of keys) om.has(k); }, iterations),
      bench(() => { for (const k of keys) iom.has(k); }, iterations),
      bench(() => { for (const k of keys) nm.has(k); }, iterations));

    printRow('delete',
      bench(() => { let x = om; for (let i = 0; i < 10; i++) x = x.delete(keys[i]); }, iterations),
      bench(() => { let x = iom; for (let i = 0; i < 10; i++) x = x.delete(keys[i]); }, iterations),
      bench(() => { const x = new Map(nm); for (let i = 0; i < 10; i++) x.delete(keys[i]); }, iterations));

    printRow('forEach',
      bench(() => { let c = 0; om.forEach(() => c++); }, iterations),
      bench(() => { let c = 0; iom.forEach(() => c++); }, iterations),
      bench(() => { let c = 0; nm.forEach(() => c++); }, iterations));
  }
}

async function benchSortedMap() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SharedSortedMap vs Native Map (sorted iteration)`);
  console.log(`${'='.repeat(80)}`);

  for (const N of [100, 1000, 10000]) {
    resetSortedMap();
    const iterations = Math.max(50, Math.floor(10000 / N));
    const keys = Array.from({ length: N }, (_, i) => `key${String(i).padStart(5, '0')}`);
    const shuffledKeys = [...keys].sort(() => Math.random() - 0.5);
    const vals = Array.from({ length: N }, (_, i) => i);

    console.log(`\n--- N=${N} (${iterations} iterations) ---`);
    header2();

    const smSet = bench(() => { resetSortedMap(); let m = new SharedSortedMap('number'); for (let i = 0; i < N; i++) m = m.set(shuffledKeys[i], vals[i]); }, iterations);
    const nmSet = bench(() => { const m = new Map(); for (let i = 0; i < N; i++) m.set(shuffledKeys[i], vals[i]); }, iterations);
    console.log(`${'set'.padEnd(14)} │ ${smSet.toFixed(4).padStart(11)} │ ${nmSet.toFixed(4).padStart(8)} │ ${smSet < nmSet ? `${(nmSet/smSet).toFixed(2)}x faster` : `${(smSet/nmSet).toFixed(2)}x slower`}`);

    resetSortedMap();
    let sm = new SharedSortedMap('number'); for (let i = 0; i < N; i++) sm = sm.set(shuffledKeys[i], vals[i]);
    const nm = new Map(shuffledKeys.map((k,i) => [k, vals[i]]));

    const smGet = bench(() => { for (const k of keys) sm.get(k); }, iterations);
    const nmGet = bench(() => { for (const k of keys) nm.get(k); }, iterations);
    console.log(`${'get'.padEnd(14)} │ ${smGet.toFixed(4).padStart(11)} │ ${nmGet.toFixed(4).padStart(8)} │ ${smGet < nmGet ? `${(nmGet/smGet).toFixed(2)}x faster` : `${(smGet/nmGet).toFixed(2)}x slower`}`);

    const smHas = bench(() => { for (const k of keys) sm.has(k); }, iterations);
    const nmHas = bench(() => { for (const k of keys) nm.has(k); }, iterations);
    console.log(`${'has'.padEnd(14)} │ ${smHas.toFixed(4).padStart(11)} │ ${nmHas.toFixed(4).padStart(8)} │ ${smHas < nmHas ? `${(nmHas/smHas).toFixed(2)}x faster` : `${(smHas/nmHas).toFixed(2)}x slower`}`);

    const smDelete = bench(() => { let x = sm; for (let i = 0; i < 10; i++) x = x.delete(keys[i]); }, iterations);
    const nmDelete = bench(() => { const x = new Map(nm); for (let i = 0; i < 10; i++) x.delete(keys[i]); }, iterations);
    console.log(`${'delete'.padEnd(14)} │ ${smDelete.toFixed(4).padStart(11)} │ ${nmDelete.toFixed(4).padStart(8)} │ ${smDelete < nmDelete ? `${(nmDelete/smDelete).toFixed(2)}x faster` : `${(smDelete/nmDelete).toFixed(2)}x slower`}`);

    const smIter = bench(() => { let c = 0; for (const _ of sm.keys()) c++; }, iterations);
    const nmIter = bench(() => { let c = 0; for (const _ of [...nm.keys()].sort()) c++; }, iterations);
    console.log(`${'keys(sorted)'.padEnd(14)} │ ${smIter.toFixed(4).padStart(11)} │ ${nmIter.toFixed(4).padStart(8)} │ ${smIter < nmIter ? `${(nmIter/smIter).toFixed(2)}x faster` : `${(smIter/nmIter).toFixed(2)}x slower`}`);
  }
}

async function benchPriorityQueue() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SharedPriorityQueue vs Native Array (sorted insert)`);
  console.log(`${'='.repeat(80)}`);

  for (const N of [1000, 10000]) {
    resetPriorityQueue();
    const iterations = Math.max(50, Math.floor(10000 / N));
    console.log(`\nN=${N}, iterations=${iterations}`);
    header2();

    // Enqueue
    const pqEnq = bench(() => {
      let pq = new SharedPriorityQueue('number');
      for (let i = 0; i < N; i++) pq = pq.enqueue(i, Math.random() * N);
    }, iterations);
    const arrEnq = bench(() => {
      const arr: [number, number][] = [];
      for (let i = 0; i < N; i++) {
        const p = Math.random() * N;
        const idx = arr.findIndex(([, pr]) => pr > p);
        if (idx === -1) arr.push([i, p]);
        else arr.splice(idx, 0, [i, p]);
      }
    }, iterations);
    console.log(`${'enqueue'.padEnd(14)} │ ${pqEnq.toFixed(4).padStart(11)} │ ${arrEnq.toFixed(4).padStart(8)} │ ${pqEnq < arrEnq ? `${(arrEnq/pqEnq).toFixed(2)}x faster` : `${(pqEnq/arrEnq).toFixed(2)}x slower`}`);

    // Build queues for other tests
    let pq = new SharedPriorityQueue('number');
    const arr: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const p = Math.random() * N;
      pq = pq.enqueue(i, p);
      const idx = arr.findIndex(([, pr]) => pr > p);
      if (idx === -1) arr.push([i, p]);
      else arr.splice(idx, 0, [i, p]);
    }

    // Peek
    const pqPeek = bench(() => { for (let i = 0; i < 100; i++) pq.peek(); }, iterations * 10);
    const arrPeek = bench(() => { for (let i = 0; i < 100; i++) arr[0]; }, iterations * 10);
    console.log(`${'peek(100)'.padEnd(14)} │ ${pqPeek.toFixed(4).padStart(11)} │ ${arrPeek.toFixed(4).padStart(8)} │ ${pqPeek < arrPeek ? `${(arrPeek/pqPeek).toFixed(2)}x faster` : `${(pqPeek/arrPeek).toFixed(2)}x slower`}`);

    // Dequeue
    const pqDeq = bench(() => { let x = pq; for (let i = 0; i < 10; i++) x = x.dequeue(); }, iterations);
    const arrDeq = bench(() => { const x = [...arr]; for (let i = 0; i < 10; i++) x.shift(); }, iterations);
    console.log(`${'dequeue(10)'.padEnd(14)} │ ${pqDeq.toFixed(4).padStart(11)} │ ${arrDeq.toFixed(4).padStart(8)} │ ${pqDeq < arrDeq ? `${(arrDeq/pqDeq).toFixed(2)}x faster` : `${(pqDeq/arrDeq).toFixed(2)}x slower`}`);
  }
}

async function run() {
  await benchSharedMap();
  await benchSet();
  await benchList();
  await benchStack();
  await benchQueue();
  await benchLinkedList();
  await benchDoublyLinkedList();
  await benchOrderedMap();
  await benchSortedMap();
  await benchPriorityQueue();
  await benchStringTypes();
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Summary`);
  console.log(`${'='.repeat(80)}`);
  console.log(`
Key Advantages of Shared* structures:
• SharedArrayBuffer enables zero-copy cross-worker sharing
• Immutable/persistent - safe concurrent reads
• WASM-accelerated operations
• O(1) Stack push/pop/peek, O(1) Queue enqueue/dequeue/peek
• O(1) LinkedList prepend/removeFirst, O(1) DoublyLinkedList prepend/append/removeFirst/removeLast
• O(log32 n) Map/Set/List/OrderedMap/OrderedSet operations
• O(log n) SortedMap/SortedSet operations (Red-Black Tree)

Native structures are mutable and cannot be safely shared across workers.
`);
}

run();
