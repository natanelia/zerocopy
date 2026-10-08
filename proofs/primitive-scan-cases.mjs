/** Diagnostic timings, not a pass/fail performance gate. No runtime imports. */
import { equalValues } from './primitive-scan-checks.mjs';
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const quantile = (a, fraction) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * fraction)];
const score = value => typeof value === 'number' ? value : typeof value === 'boolean' ? Number(value)
  : typeof value === 'string' ? value.length : value.id;

export function makeCases(apis, size, type, name) {
  const expected = Array.from({ length: size }, (_, i) => type === 'number' ? i + 0.5
    : type === 'boolean' ? i % 3 === 0 : type === 'string' ? `界-${i}` : { id: i, label: `row-${i}` });
  const source = apis.map(api => {
    // Private arenas prevent unrelated fixtures accumulating in module defaults.
    let item = api.compact(new api[name](type));
    if (name === 'SharedList') return item.pushMany(expected);
    for (const value of expected) item = item.append(value);
    return item;
  });
  for (const item of source) equalValues(item.toArray(), expected, 'fixture');
  const methods = name === 'SharedList' ? ['forEach', 'toArray', 'values']
    : name === 'SharedLinkedList' ? ['forEach', 'toArray']
    : ['forEach', 'toArray', 'forEachReverse', 'toArrayReverse'];
  return methods.map(method => {
    const reverse = method.endsWith('Reverse'), array = method.startsWith('toArray');
    const ordered = reverse ? expected.slice().reverse() : expected;
    const sum = ordered.reduce((total, value, i) => total + score(value) * ((i & 31) + 1), 0);
    return {
      name: `${name}<${type}>.${method}`, size, array,
      run(which) {
        const item = source[which];
        if (array) return item[method]();
        let result = 0, count = 0;
        if (method === 'values') for (const value of item.values()) result += score(value) * (((count++) & 31) + 1);
        else item[method]((value, index) => {
          const position = reverse ? size - 1 - index : index;
          result += score(value) * ((position & 31) + 1); count++;
        });
        if (count !== size) throw new Error('Incomplete scan');
        return result;
      },
      check(result) {
        // Every retained array from every timed iteration is checked in full,
        // after stopping the timer. Scalar scans use an order-sensitive sum.
        if (array) {
          if (result.length !== ordered.length) throw new Error('Array length mismatch');
          for (let i = 0; i < ordered.length; i++) {
            const a = result[i], b = ordered[i];
            const same = type === 'object' ? a?.id === b.id && a?.label === b.label : Object.is(a, b);
            if (!same) throw new Error(`${name}.${method}: mismatch at ${i}`);
          }
        }
        else if (result !== sum) throw new Error(`${name}.${method}: checksum mismatch`);
      },
    };
  });
}
export function measureCase(item, options = {}) {
  const samples = options.samples ?? 15, targetMs = options.targetMs ?? 8;
  const offset = options.round ?? 0, times = [[], []];
  // Bound retained output references to approximately 8 MiB plus object headers.
  const cap = item.array ? Math.max(1, Math.min(128, Math.floor(8 * 1024 * 1024 / (8 * item.size)))) : 1024;
  function batch(which, repeat) {
    const outputs = new Array(repeat);
    const start = performance.now();
    for (let r = 0; r < repeat; r++) outputs[r] = item.run(which);
    const elapsed = performance.now() - start;
    for (const output of outputs) item.check(output);
    return elapsed;
  }
  for (let i = 0; i < 6; i++) { const first = (i + offset) & 1; batch(first, 1); batch(1 - first, 1); }
  let repeat = 1;
  while (repeat < cap) {
    const first = offset & 1;
    const a = batch(first, repeat), b = batch(1 - first, repeat);
    if (Math.min(a, b) >= targetMs) break;
    repeat = Math.min(cap, repeat * 2);
  }
  for (let i = 0; i < 6; i++) { const first = (i + offset) & 1; batch(first, repeat); batch(1 - first, repeat); }
  for (let i = 0; i < samples; i++) {
    const first = (i + offset) & 1;
    times[first].push(batch(first, repeat)); times[1 - first].push(batch(1 - first, repeat));
  }
  const before = median(times[0]), after = median(times[1]);
  return { name: item.name, size: item.size, repeat, baselineMedianMs: before, candidateMedianMs: after,
    speedup: before / after, baselineSamplesMs: times[0], candidateSamplesMs: times[1],
    baselineP10Ms: quantile(times[0], 0.1), baselineP90Ms: quantile(times[0], 0.9),
    candidateP10Ms: quantile(times[1], 0.1), candidateP90Ms: quantile(times[1], 0.9),
    shortBatch: Math.min(before, after) < targetMs,
    reviewSlowdown: after > before * 1.10 && quantile(times[1], 0.1) > quantile(times[0], 0.9) };
}
export async function runComparison(baseline, candidate, options = {}) {
  const sizes = options.sizes ?? [33, 32769], rows = [];
  for (const type of ['number', 'boolean', 'string', 'object']) {
    for (const size of type === 'number' || type === 'boolean' ? sizes : [1057]) {
      for (const name of ['SharedList', 'SharedLinkedList', 'SharedDoublyLinkedList']) {
        for (const item of makeCases([baseline, candidate], size, type, name)) {
          const row = measureCase(item, options); rows.push(row);
          console.log(`${row.name} n=${row.size}: ${row.speedup.toFixed(2)}x${row.reviewSlowdown ? ' REVIEW SLOWDOWN' : ''}`);
        }
        // Let the runtime service tasks between fixtures; never inside a timer.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }
  return { purpose: 'diagnostic; correctness failures throw, timing ratios do not',
    samples: options.samples ?? 15, targetMs: options.targetMs ?? 8, rows };
}
