// Pure fixture and public-loop accounting. No candidate package imports or clocks.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture, runBody, digest} from './fixtures.mjs';
import {resourceSummary} from './subject.mjs';
const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'));
const golden = JSON.parse(readFileSync(new URL('./fixture-expected.json', import.meta.url), 'utf8'));
let checks = 0;
function check(fn) { fn(); checks++; }
for (const spec of protocol.cases) {
  const input = fixture(spec), expected = golden[spec.id];
  check(() => assert.equal(input.inputDigest, expected.inputDigest));
  check(() => assert.equal(input.expectedDigest, expected.expectedDigest));
  check(() => assert.equal(input.expected.size, spec.resultSize));
  check(() => assert.equal(input.entries.length, spec.size));
  check(() => assert(Object.isFrozen(input.entries) && input.entries.every(Object.isFrozen)));
  check(() => assert(Object.isFrozen(input.seed) && input.seed.every(Object.isFrozen)));
  check(() => assert.equal(new Set(input.entries.map(([key]) => key)).size, spec.size));
  for (const operations of [spec.ladder[0], spec.ladder.at(-1)]) {
    let calls = 0, last;
    const root = {setMany(entries) { assert.equal(entries, input.entries); calls++; last = {size: spec.resultSize}; return last; }};
    const api = {compact(source) { assert.equal(source, root); calls++; last = {size: spec.resultSize}; return last; }};
    const result = runBody(api, spec, root, input, operations);
    check(() => assert.equal(calls, operations)); check(() => assert.equal(result.output, last));
    check(() => assert.equal(result.checksum, operations * spec.resultSize)); check(() => assert(Number.isSafeInteger(result.checksum)));
    check(() => assert.equal(digest([input.entries, input.seed]), input.inputDigest));
  }
}
const half = fixture(protocol.cases.find(spec => spec.shape === 'half-replace'));
check(() => assert.equal(half.seed.length, 4096));
const seedKeys = new Set(half.seed.map(([key]) => key));
check(() => assert.equal(half.entries.filter(([key]) => seedKeys.has(key)).length, 2048));
check(() => assert.equal(half.expected.get('key-ascii-04096'), 4096 * 0.25 - 512 + 10000));
check(() => assert.equal(half.expected.get('key-ascii-02048'), 2048 * 0.25 - 512));
const mixed = fixture(protocol.cases.find(spec => spec.shape === 'mixed'));
check(() => assert.equal(mixed.entries.filter(([key]) => /[^\x00-\x7f]/.test(key)).length, 1024));
check(() => assert.equal(mixed.entries.filter(([, value]) => /[^\x00-\x7f]/.test(value)).length, 1024));
const subject = readFileSync(new URL('./subject.mjs', import.meta.url), 'utf8');
check(() => assert(subject.includes("spec.ladder[0], 'untimed-minimum'")));
check(() => assert(subject.includes("if (!timed) Object.defineProperty(performance, 'now'")));
check(() => assert.equal(subject.match(/performance\.now\(\)/g).length, 2));
const rawResourceUsage = {maxRSS: 5000, userCPUTime: 123};
const resource = resourceSummary(rawResourceUsage);
check(() => assert.equal(resource.resourceUsage, rawResourceUsage));
check(() => assert.deepEqual(resource.resourceUsageUnits, {maxRSS: 'KiB', bytesPerMaxRSSUnit: 1024}));
check(() => assert.equal(resource.maxRSSBytes, 5120000));
check(() => assert.match(resource.resourceUsageScope, /separate from sampled RSS and per-Arena backing capacity/));
console.log(JSON.stringify({pureSubjectChecks: checks, passed: true, candidateLoaded: false, operationClocks: false}));
