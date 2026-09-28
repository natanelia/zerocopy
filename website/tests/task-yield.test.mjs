import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { yieldToEvents } from '../assets/task-yield.mjs';
import { generateColumns, nativeView, search, summarizeEvents } from '../assets/explorer-core.mjs';

test('each yield runs in a task, not only the microtask queue', async () => {
  let resumed = false;
  const waiting = yieldToEvents().then(() => { resumed = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(resumed, false);
  await waiting; assert.equal(resumed, true);
});
test('concurrent and reentrant yields each settle once and keep FIFO order', async () => {
  const completed = [];
  await Promise.all(Array.from({ length: 100 }, (_, i) => yieldToEvents().then(() => { completed.push(i); })));
  assert.deepEqual(completed, Array.from({ length: 100 }, (_, i) => i));
  for (let i = 0; i < 100; i++) await yieldToEvents();
});
test('search and summary still process a cancellation posted from another message task', async () => {
  const view = nativeView(generateColumns(0, 100000));
  for (const calculate of [search, summarizeEvents]) {
    let cancelled = false;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { cancelled = true; };
    try {
      const result = calculate(view, {}, () => cancelled);
      channel.port2.postMessage('cancel');
      await assert.rejects(result, /cancelled/);
    } finally { channel.port1.close(); channel.port2.close(); }
  }
});
