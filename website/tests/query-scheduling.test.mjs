import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';
import { FIELDS, MAX_EVENTS, generateColumns, nativeView, search, summarizeEvents, yieldToEvents } from '../assets/explorer-core.mjs';
import { emptyShared, appendShared } from '../_site/compare/assets/explorer-storage.mjs';

test('concurrent query yields cross a task boundary and all waiters complete', async () => {
  let completed = 0;
  const pending = Array.from({ length: 20 }, () => yieldToEvents().then(() => completed++));
  await Promise.resolve();
  assert.equal(completed, 0, 'A microtask is not a cancellation checkpoint');
  await Promise.all(pending);
  assert.equal(completed, 20);
  await yieldToEvents();
});

test('a queued message can cancel a running scan before it reads the full dataset', async () => {
  for (const scan of [search, summarizeEvents]) {
    const channel = new NodeMessageChannel();
    let cancelled = false, reads = 0;
    const input = nativeView(generateColumns(0, 100000));
    const view = { length: input.length, get(field, i) { reads++; return input.get(field, i); } };
    channel.port1.onmessage = () => { cancelled = true; };
    try {
      channel.port2.postMessage(null);
      await assert.rejects(scan(view, {}, () => cancelled), /cancelled/);
      assert.ok(reads < 100000, 'Cancellation must stop the scan, not only reject its final answer');
    } finally { channel.port1.close(); channel.port2.close(); }
  }
});

test('timer fallback remains available when MessageChannel is absent', async () => {
  const original = globalThis.MessageChannel;
  try { globalThis.MessageChannel = undefined; await yieldToEvents(); }
  finally { globalThis.MessageChannel = original; }
});

test('shared batch append validates equal column lengths and capacity before publication', () => {
  const first = generateColumns(0, 33), old = appendShared(emptyShared(), first);
  const next = appendShared(old, generateColumns(33, 1024));
  for (const field of FIELDS) assert.deepEqual(old[field].toArray(), first[field]);
  assert.equal(next.time.size, 1057);
  assert.throws(() => appendShared(old, { ...first, level: [] }), /length/);
  const full = Object.fromEntries(FIELDS.map(field => [field, { size: MAX_EVENTS, get() {}, pushMany() { throw new Error('Should not append'); } }]));
  assert.throws(() => appendShared(full, first), /capacity/);
});
