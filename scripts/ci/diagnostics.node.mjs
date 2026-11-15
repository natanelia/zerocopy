import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configuration, guardOutputs, plan, suites } from './diagnostics.mjs';

test('only explicit supported suites and runner combinations are accepted', () => {
  assert.equal(configuration({}).suite, 'compatibility');
  for (const suite of suites) {
    assert.equal(configuration({ DIAGNOSTIC_SUITE: suite, DIAGNOSTIC_ARCHITECTURE: 'arm64' }).suite, suite);
  }
  assert.throws(() => configuration({ DIAGNOSTIC_SUITE: 'all' }), /one supported/);
  assert.throws(() => configuration({ DIAGNOSTIC_ARCHITECTURE: 'arm64', DIAGNOSTIC_BROWSERS: 'true' }), /x64/);
  assert.throws(() => configuration({ DIAGNOSTIC_SUITE: 'memory', DIAGNOSTIC_BROWSERS: 'true' }), /Node workers/);
  assert.throws(() => configuration({ DIAGNOSTIC_NODE_VERSION: '18' }), /Node 22 or 24/);
  assert.throws(() => configuration({ DIAGNOSTIC_BROWSERS: 'yes' }), /true or false/);
});

test('baseline refs cannot become shell commands, Git options, or revision expressions', () => {
  for (const baselineRef of ['--upload-pack=bad', '$(touch bad)', 'main\nHEAD', 'main;echo bad', '../main', 'HEAD~1']) {
    assert.throws(() => configuration({ DIAGNOSTIC_BASELINE_REF: baselineRef }), /Baseline must/);
  }
  for (const baselineRef of ['main', 'feature/utf8', 'v0.2.1', '75e3626ccc6400d1ae195aefdd3526906622009e']) {
    assert.equal(configuration({ DIAGNOSTIC_BASELINE_REF: baselineRef }).baselineRef, baselineRef);
  }
});

test('JSON preserves every original native and browser sample in sequential stages', () => {
  const selected = plan(configuration({ DIAGNOSTIC_SUITE: 'json', DIAGNOSTIC_BROWSERS: 'true' }));
  const native = selected.steps.findIndex(step => step.args[0] === 'proofs/run-json-read.mjs');
  const browser = selected.steps.findIndex(step => step.args[0] === 'proofs/json-read-browser.mjs');
  assert(native >= 0 && browser > native);
  assert.deepEqual(selected.steps[native].env, { JSON_READ_WARMUPS: '10', JSON_READ_SAMPLES: '12', JSON_READ_ROUNDS: '3' });
  assert.deepEqual(selected.steps[browser].env, { JSON_READ_WARMUPS: '5', JSON_READ_SAMPLES: '7', JSON_READ_ROUNDS: '3' });
  assert.deepEqual(selected.steps.find(step => step.args.includes('playwright')).args.slice(-3), ['chromium', 'firefox', 'webkit']);
  assert.equal(selected.baselineRef, 'main');
});

test('UTF-8 retains native/browser driver defaults and browser setup is opt-in', () => {
  const native = plan(configuration({ DIAGNOSTIC_SUITE: 'utf8' }));
  assert(!native.steps.some(step => step.args.includes('playwright')));
  assert(!native.steps.some(step => step.args[0] === 'proofs/utf8-write-browser.mjs'));
  assert.deepEqual(native.steps.find(step => step.args[0] === 'proofs/run-utf8-write.mjs').env, {});
  const browser = plan(configuration({ DIAGNOSTIC_SUITE: 'utf8', DIAGNOSTIC_BROWSERS: 'true' }));
  assert.deepEqual(browser.steps.find(step => step.args[0] === 'proofs/utf8-write-browser.mjs').env, {});
});

test('kernel suites preserve original gates and only numeric browsers need the pinned baseline', () => {
  for (const suite of ['numeric', 'geometry', 'spatial']) {
    const native = plan(configuration({ DIAGNOSTIC_SUITE: suite, DIAGNOSTIC_ARCHITECTURE: 'arm64' }));
    const gates = native.steps.filter(step => step.env.PERF_GATE === '1');
    assert.equal(gates.length, suite === 'spatial' ? 3 : 2);
    assert(gates.some(step => step.command === 'node') && gates.some(step => step.command === 'bun'));
    assert.equal(native.baselineRef, null);
    assert(!native.steps.some(step => step.args.includes('playwright')));
    const browser = plan(configuration({ DIAGNOSTIC_SUITE: suite, DIAGNOSTIC_BROWSERS: 'true' }));
    assert.equal(browser.baselineRef, suite === 'numeric' ? '75e3626ccc6400d1ae195aefdd3526906622009e' : null);
    assert(browser.fixedOutputs.includes(`proofs/results/${suite}-browsers.json`));
  }
});

test('fixed driver outputs cannot replace existing or tracked historical evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'diagnostics-guard-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    mkdirSync(join(root, 'proofs/results'), { recursive: true });
    const file = 'proofs/results/numeric-node-x64.json';
    guardOutputs(root, [file]);
    writeFileSync(join(root, file), 'old evidence');
    assert.throws(() => guardOutputs(root, [file]), /Refusing to overwrite/);
    execFileSync('git', ['add', file], { cwd: root });
    rmSync(join(root, file));
    assert.throws(() => guardOutputs(root, [file]), /Refusing to overwrite/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
