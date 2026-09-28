import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchScheduler } from './query-control.mjs';
const candidate = readFileSync(new URL('../website/assets/explorer-core.mjs', import.meta.url), 'utf8');
const start = candidate.indexOf('// Yield a real task');
const end = candidate.indexOf('/** Periodic task-queue yields');
const legacy = candidate.slice(0, start) + 'export const yieldToEvents = () => new Promise(resolve => setTimeout(resolve, 0));\n' + candidate.slice(end);
test('the legacy timer control changes only the known scheduler region', () => {
  assert.equal(matchScheduler(legacy, candidate), candidate);
});
test('a modern PR base can already contain the new scheduler', () => {
  assert.equal(matchScheduler(candidate, candidate), candidate);
});
test('different scheduling implementations can use the same control', () => {
  const other = candidate.replace('return globalThis.scheduler.yield()', 'return globalThis.scheduler.yield({ priority: "background" })');
  assert.equal(matchScheduler(other, candidate), candidate);
});
test('unrelated predicate or data changes cannot be credited to the engine', () => {
  assert.throws(() => matchScheduler(legacy.replace('Upstream timeout', 'Different fixture'), candidate), /outside the scheduler/);
  assert.throws(() => matchScheduler(legacy.replace('index & 4095', 'index & 8191'), candidate), /outside the scheduler/);
});
test('unknown formats fail instead of silently constructing a misleading control', () => {
  assert.throws(() => matchScheduler('export const changed = 1;', candidate), /Unknown scheduler layout/);
});
