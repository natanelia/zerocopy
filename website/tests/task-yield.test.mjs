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

// Exercise the browser branch without Node's setImmediate shortcut. Task
// delivery is controlled so lost, delayed and reordered port events are exact.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
function browserScheduler({ sendError = false, constructorError = false } = {}) {
  const timers = new Map(), messages = [], ports = [];
  let timerId = 0;
  class Channel {
    constructor() {
      if (constructorError) throw new Error('MessageChannel unavailable');
      this.port1 = { start() {}, close() {}, ref() {}, unref() {}, onmessage: null };
      this.port2 = { close() {}, ref() {}, unref() {}, postMessage: id => {
        if (sendError) throw new Error('Cannot post');
        messages.push(() => this.port1.onmessage({ data: id }));
      } };
      ports.push(this);
    }
  }
  const context = vm.createContext({ MessageChannel: Channel,
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(readFileSync(new URL('../assets/task-yield.mjs', import.meta.url), 'utf8').replace('export function yieldToEvents', 'function yieldToEvents') + '\nglobalThis.run = yieldToEvents;', context);
  return { run: () => context.run(), timers, messages, ports,
    timer() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); },
    message() { messages.shift()(); },
  };
}
test('browser port win cancels its timer and late tasks never settle the next yield', async () => {
  const b = browserScheduler(); let first = 0, second = 0;
  const one = b.run().then(() => first++);
  b.message(); await one;
  assert.equal(b.timers.size, 0); assert.equal(first, 1);
  const two = b.run().then(() => second++);
  await Promise.resolve(); assert.equal(second, 0);
  b.timer(); await two;
  const three = b.run(); let third = 0; three.then(() => third++);
  b.message(); await Promise.resolve(); assert.equal(third, 0, 'old port event must not complete the new request');
  b.message(); await three;
  assert.equal(second, 1); assert.equal(third, 1); assert.equal(b.timers.size, 0);
});
test('browser timer tasks make progress when the message channel never delivers', async () => {
  const b = browserScheduler(); const done = [];
  const all = Array.from({ length: 100 }, (_, i) => b.run().then(() => done.push(i)));
  assert.equal(done.length, 0);
  while (b.timers.size) b.timer();
  await Promise.all(all); assert.deepEqual(done, Array.from({ length: 100 }, (_, i) => i));
  while (b.messages.length) b.message();
  assert.equal(done.length, 100); assert.equal(b.ports.length, 1);
});
test('browser send and constructor failures still yield through a timer task', async () => {
  for (const options of [{ sendError: true }, { constructorError: true }]) {
    const b = browserScheduler(options); let completed = false;
    const result = b.run().then(() => { completed = true; });
    await Promise.resolve(); assert.equal(completed, false);
    b.timer(); await result; assert.equal(completed, true); assert.equal(b.timers.size, 0);
  }
});
