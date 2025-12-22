import { Map as ImmutableMap } from 'immutable';
import { HAMT, resetBuffer, getUsedBytes, configureAutoGC } from './hamt';

const SIZES = [100, 1000, 10000];

function bench(fn: () => void, iterations: number): number {
  for (let i = 0; i < Math.min(50, iterations); i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return (performance.now() - start) / iterations;
}

function printRow(op: string, hamtMs: number, immMs: number) {
  const ratio = hamtMs < immMs 
    ? `${(immMs/hamtMs).toFixed(2)}x faster` 
    : `${(hamtMs/immMs).toFixed(2)}x slower`;
  console.log(`${op.padEnd(12)} │ ${hamtMs.toFixed(4).padStart(9)} │ ${immMs.toFixed(4).padStart(8)} │ ${ratio}`);
}

async function run() {
  console.log(`\n=== HAMT vs Immutable.js ===`);
  configureAutoGC({ enabled: false });

  for (const N of SIZES) {
    const iterations = Math.max(100, Math.floor(50000 / N));
    const keys = Array.from({ length: N }, (_, i) => `key${i}`);
    const strVals = Array.from({ length: N }, (_, i) => `value${i}`);
    const strEntries: [string, string][] = keys.map((k, i) => [k, strVals[i]]);

    console.log(`\n--- N=${N} (${iterations} iterations) ---`);
    console.log('Operation     │ HAMT (ms) │ Imm (ms) │ Ratio');
    console.log('──────────────┼───────────┼──────────┼────────');

    // Insert
    printRow('insert',
      bench(() => { resetBuffer(); let x = new HAMT('string'); for (let i = 0; i < N; i++) x = x.set(keys[i], strVals[i]); }, iterations),
      bench(() => { let m = ImmutableMap<string, string>(); for (let i = 0; i < N; i++) m = m.set(keys[i], strVals[i]); }, iterations));

    // Batch insert (skip for large N to avoid OOM)
    if (N <= 1000) {
      printRow('batch ins',
        bench(() => { resetBuffer(); new HAMT('string').setMany(strEntries); }, iterations),
        bench(() => { ImmutableMap<string, string>(strEntries); }, iterations));
    }

    // Build HAMTs for read tests
    resetBuffer();
    let hStr = new HAMT('string'); 
    let imStr = ImmutableMap<string, string>();
    for (let i = 0; i < N; i++) { hStr = hStr.set(keys[i], strVals[i]); imStr = imStr.set(keys[i], strVals[i]); }

    // Get
    printRow('get',
      bench(() => { for (let i = 0; i < N; i++) hStr.get(keys[i]); }, iterations),
      bench(() => { for (let i = 0; i < N; i++) imStr.get(keys[i]); }, iterations));

    // Has
    printRow('has',
      bench(() => { for (let i = 0; i < N; i++) hStr.has(keys[i]); }, iterations),
      bench(() => { for (let i = 0; i < N; i++) imStr.has(keys[i]); }, iterations));

    // Delete
    const delIter = Math.max(50, iterations / 5);
    printRow('delete',
      bench(() => { let x = hStr; for (let i = 0; i < 10; i++) x = x.delete(keys[i]); }, delIter),
      bench(() => { let m = imStr; for (let i = 0; i < 10; i++) m = m.delete(keys[i]); }, delIter));

    // Iteration
    printRow('iter',
      bench(() => { let s = 0; hStr.forEach(() => s++); }, iterations),
      bench(() => { let s = 0; imStr.forEach(() => s++); }, iterations));
  }

  console.log(`\n--- Key Advantage ---`);
  console.log(`HAMT uses SharedArrayBuffer for zero-copy worker sharing.`);
}

run();
