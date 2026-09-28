import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SharedList, initWorker, getWorkerData, resetSharedList } from '../dist/shared.js';

test('front-cache collisions retain all bounded decoded values without decoding again', async () => {
  resetSharedList();
  const values = Array.from({ length: 1500 }, (_, i) => `event ${i}: 日本語 response with unique text`);
  const source = new SharedList('string').pushMany(values);
  const reader = (await initWorker(getWorkerData({ source }, { copy: false }))).source;
  const originalDecode = TextDecoder.prototype.decode;
  let decodes = 0;
  TextDecoder.prototype.decode = function (...args) { decodes++; return Reflect.apply(originalDecode, this, args); };
  try {
    for (let i = 0; i < values.length; i++) assert.equal(reader.get(i), values[i]);
    assert.equal(decodes, values.length);
    // There are only 64 front-cache slots. All 1500 values must still hit the
    // backing cache on reverse, forward and interleaved access.
    for (let repeat = 0; repeat < 3; repeat++) for (let i = 0; i < values.length; i++) {
      assert.equal(reader.get(i), values[i]);
      assert.equal(reader.get(values.length - i - 1), values[values.length - i - 1]);
    }
    assert.equal(decodes, values.length, 'a front-cache collision must not evict its backing entry');
  } finally { TextDecoder.prototype.decode = originalDecode; }
});
