import test from 'node:test';
import assert from 'node:assert/strict';

// Preserve the distinct concurrent-caller and process-exit regression from
// PR #14 without replacing the newer scheduler and compiled text search.
test('cooperative scheduling yields a task, handles concurrent callers, and allows Node to exit', async () => {
  const { yieldToEvents } = await import('../assets/explorer-core.mjs');
  let completed = false;
  const pending = yieldToEvents().then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false, 'A microtask is not a cancellation checkpoint');
  await Promise.all([pending, ...Array.from({ length: 32 }, () => yieldToEvents())]);
  assert.equal(completed, true);
  const { spawnSync } = await import('node:child_process');
  const core = new URL('../assets/explorer-core.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const {yieldToEvents} = await import(${JSON.stringify(core)}); await yieldToEvents(); console.log('finished');`], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /finished/);
});
