import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median } from './audit.mjs';
test('reject invalid time samples', () => {
  for (const xs of [[], [0], [-1,2], [1,NaN], [2,Infinity]]) assert.throws(() => median(xs));
});
test('median keeps every sample and input order', () => {
  const x = [7,1,2,100,3,4,5,6], before = [...x];
  assert.equal(median(x), 4.5); assert.deepEqual(x, before);
  assert.equal(median([8,1,3]),3);
});
