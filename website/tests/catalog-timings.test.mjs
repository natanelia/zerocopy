import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMilliseconds, compareElapsed } from '../assets/catalog-timings.mjs';

test('elapsed milliseconds use two decimals and identify readings below display resolution', () => {
  assert.equal(formatMilliseconds(12), '12.00 ms');
  assert.equal(formatMilliseconds(1.234), '1.23 ms');
  assert.equal(formatMilliseconds(1.236), '1.24 ms');
  assert.equal(formatMilliseconds(0.01), '0.01 ms');
  assert.equal(formatMilliseconds(1e21), '1000000000000000000000.00 ms');
  for (const value of [0, -0, Number.MIN_VALUE, 0.004, 0.0099]) {
    assert.equal(formatMilliseconds(value), '<0.01 ms');
  }
});

test('missing and invalid milliseconds never become a measured duration', () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, -1, -0.001, '1', '', false, {}]) {
    assert.equal(formatMilliseconds(value), '—');
  }
  assert.equal(formatMilliseconds(), '—');
});

test('elapsed comparisons use native as the denominator and qualify the observation', () => {
  assert.equal(compareElapsed(75, 100), '25% less time vs native · this run');
  assert.equal(compareElapsed(125, 100), '25% more time vs native · this run');
  assert.equal(compareElapsed(300, 100), '200% more time vs native · this run');
  assert.equal(compareElapsed(1, 3), '66.7% less time vs native · this run');
  assert.equal(compareElapsed(0.01, 0.02), '50% less time vs native · this run');
});

test('equal readings and two-decimal ties do not imply a measured advantage', () => {
  const same = 'Same at displayed precision vs native · this run';
  assert.equal(compareElapsed(5, 5), same);
  assert.equal(compareElapsed(1.231, 1.234), same);
  assert.equal(compareElapsed(1.234, 1.231), same);
  assert.equal(compareElapsed(0.011, 0.014), same);
});

test('comparisons suppress ratios when either reading is missing, invalid, zero or below resolution', () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, -1, -0.001, '1', '', false, {}, 0, -0, 0.004, 0.0099]) {
    assert.equal(compareElapsed(value, 1), '—');
    assert.equal(compareElapsed(1, value), '—');
    assert.equal(compareElapsed(value, value), '—');
  }
  assert.equal(compareElapsed(), '—');
  assert.equal(compareElapsed(1), '—');
});

test('percentage rounding preserves small differences without claiming zero elapsed time', () => {
  assert.equal(compareElapsed(99.99, 100), '<0.1% less time vs native · this run');
  assert.equal(compareElapsed(100.01, 100), '<0.1% more time vs native · this run');
  assert.equal(compareElapsed(0.01, 1000), '>99.9% less time vs native · this run');
  assert.equal(compareElapsed(Number.MAX_VALUE, 0.01), '—');
});

test('the comparison leads with measured timing phases and keeps verification secondary', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../_site/compare/index.html', import.meta.url), 'utf8');
  assert.match(html, /Compare product-catalog/);
  for (const label of ['Latest read + validate', 'Build collection', 'Initial handoff', 'Replace + handoff']) assert.ok(html.includes(label));
  assert.ok(html.indexOf('data-timing>') < html.indexOf('data-found>'));
  assert.equal((html.match(/data-timing>—/g) || []).length, 4);
  assert.equal((html.match(/class="feature-correctness"/g) || []).length, 4);
  assert.match(html, /Worker startup and module loading are not measured/);
  assert.match(html, /single observations from this run/);
});
