import test from 'node:test';
import assert from 'node:assert/strict';
import { METHOD, endpointNames, order, expectedCount, summarize } from './paired.mjs';
function evidence(kind = 'aa', ratio = 1) {
  return Array.from({ length: 4 }, (_, block) => ({ method: METHOD, kind, block, size: 2, driver: 'fixture', source: {}, runtime: {}, arenaBytes: { A: 65536, B: 65536 },
    rows: (kind === 'slow-control' ? ['range-public'] : endpointNames(2)).map(name => ({ name, size: 2, expected: expectedCount(name, 2), iterations: 1000000,
      ...Object.fromEntries(['warmup', 'sample'].map(phase => [phase === 'warmup' ? 'warmup' : 'samples', Array.from({ length: phase === 'warmup' ? 7 : 21 }, (_, round) =>
        ({ name, size: 2, phase, round, order: order(block, round), timings: { A: ratio * 10, B: 10 },
          answers: { A: expectedCount(name, 2) * 1000000, B: expectedCount(name, 2) * 1000000 * (kind === 'slow-control' ? 2 : 1) } }))])) })) }));
}
test('exact A/A evidence clears the fixed floor and ceiling', () => assert.ok(summarize(evidence(), 'aa').every(r => r.pass)));
test('known slowdown is rejected without removing samples', () => assert.ok(summarize(evidence('ab', 0.9), 'ab').every(r => !r.pass)));
test('A/A excess speed also fails', () => assert.ok(summarize(evidence('aa', 1.1), 'aa').every(r => !r.pass)));
test('four independent process blocks are required', () => assert.throws(() => summarize(evidence().slice(0, 3), 'aa')));
test('missing or changed warmup/sample/order/oracle fails closed', () => {
  for (const change of [c => c[0].rows[0].samples.pop(), c => c[0].rows[0].warmup.pop(),
    c => c[0].rows[0].samples[0].order.reverse(), c => c[0].rows[0].expected++,
    c => c[0].rows[0].samples[0].answers.A++, c => c[0].rows[0].samples[0].timings.A = NaN,
    c => c[0].arenaBytes.B = METHOD.arenaLimitPerArm + 1, c => c[1].source = { different: true }]) {
    const c = evidence(); change(c); assert.throws(() => summarize(c, 'aa'));
  }
});
test('injected two-call control is reported as a real slowdown', () => assert.ok(summarize(evidence('slow-control', 0.5), 'slow-control').every(r => !r.pass)));
