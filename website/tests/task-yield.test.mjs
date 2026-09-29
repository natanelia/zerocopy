import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateColumns, nativeView, search, summarizeEvents, yieldToEvents } from '../assets/explorer-core.mjs';

test('cooperative yields cross a task boundary, including concurrent callers', async () => {
  let beforeYield = true;
  const a = yieldToEvents().then(() => assert.equal(beforeYield, false));
  const b = yieldToEvents().then(() => assert.equal(beforeYield, false));
  await Promise.resolve(); beforeYield = false;
  await Promise.all([a, b]);
  let task = false;
  setImmediate(() => { task = true; });
  for (let i = 0; i < 5; i++) await yieldToEvents();
  assert.equal(task, true, 'A Promise-only checkpoint would starve other tasks');
});

test('both scans still cancel after the event loop receives another task', async () => {
  const view = nativeView(generateColumns(0, 100000));
  for (const scan of [search, summarizeEvents]) {
    let cancelled = false;
    const timer = setImmediate(() => { cancelled = true; });
    try { await assert.rejects(scan(view, {}, () => cancelled), /cancelled/); }
    finally { clearImmediate(timer); }
  }
});

test('the same scheduler and checkpoints apply to all storage implementations', () => {
  const source = readFileSync(new URL('../assets/explorer-core.mjs', import.meta.url), 'utf8');
  assert.match(source, /4095/);
  assert.match(source, /scheduler\.yield\(\)/);
  const body = source.slice(source.indexOf('export async function search'));
  assert.doesNotMatch(body, /immutable|SharedList|instanceof/);
});
