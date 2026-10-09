// Pure fixture/protocol/loop checks. No zerocopy bundle imports or operation clocks.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture, runBody} from './fixtures.mjs';
import {slotPlan, logInterval, pointwiseDecision} from './math.mjs';
Object.defineProperty(performance, 'now', {value: () => { throw Error('No operation clocks in protocol tests'); }});
const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url)));
assert.equal(protocol.cases.length, 10); assert.equal(new Set(protocol.cases.map(x => x.id)).size, 10);
assert.equal(slotPlan(protocol).length, 32); assert.equal(protocol.blocks, 4);
assert.equal(protocol.memory.maximumLiveBackingBytes, 33554432);
let checks = 5;
for (const spec of protocol.cases) {
  assert(spec.ladder.length === 5 && spec.ladder.every((n, i) => Number.isSafeInteger(n) && n > 0 && (!i || n > spec.ladder[i - 1])));
  const input = fixture(spec), max = spec.ladder.at(-1);
  assert.equal(input.entries.length, spec.size); assert(Object.isFrozen(input.keys));
  let resultOwners = max;
  if (spec.operation === 'get') { assert(spec.ladder.every(n => n % 1024 === 0)); resultOwners = max / 1024; }
  if (spec.operation === 'set') resultOwners = 1;
  assert(protocol.memory.maximumSourceBackingBytes + resultOwners * spec.maximumResultOwnerBackingBytes <= protocol.memory.maximumLiveBackingBytes);
  // Every result is observable. No size getter is allowed in the measured body,
  // and every changed write must call the retained source instead of its result.
  const operations = spec.ladder[0], outputs = new Array(operations); let calls = 0;
  const fresh = () => Object.freeze({get size() { throw Error('Result observation inside body'); }});
  const root = {set(key, value) { assert.equal(this, root); assert.equal(key, input.keys[calls & 1023]); assert.equal(value, input.changed[calls & 1023]); calls++; return fresh(); }};
  const group = Object.freeze({base: root});
  const api = {compact(source) { assert.equal(source, root); calls++; return fresh(); }, compactMany(source) { assert.equal(source, group); calls++; return fresh(); }};
  const readSources = Array.from({length: Math.ceil(operations / 1024)}, (_, owner) => ({get(key) {
    assert.equal(owner, calls >>> 10); assert.equal(key, input.keys[calls & 1023]); return calls++ & 1023;
  }}));
  runBody(api, spec, input, {root, group, outputs, readSources}, operations);
  assert.equal(calls, operations); assert.equal(Object.keys(outputs).length, operations);
  checks += 6;
}
const stats = protocol.statistics;
assert.equal(pointwiseDecision(logInterval([0.04,0.04,0.04,0.04], stats.tCritical), stats, true), 'material loss supported in this cell');
assert.match(pointwiseDecision(logInterval([-0.1,-0.1,-0.1,-0.1], stats.tCritical), stats, false), /^inconclusive/);
assert.throws(() => logInterval([0,0,0], stats.tCritical)); checks += 3;
console.log(JSON.stringify({pureChecks: checks, candidateLoaded: false, operationClocks: false}));
