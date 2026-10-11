/** Prospective full-matrix controller. Run only after exact-pin review and lane release. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryHeadroom } from './full-memory-headroom.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This successor is only for the reviewed hosted workflow');
assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Do not resample by rerunning this workflow');
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
assert.ok(process.env.GITHUB_WORKSPACE?.startsWith('/') && process.env.RUNNER_TEMP?.startsWith('/'));
const base = join(process.env.RUNNER_TEMP, 'zerocopy-sharedmap-validation');
const root = process.env.GITHUB_WORKSPACE;
const node = process.execPath;
const sourceCommit = process.env.GITHUB_SHA;
const runtimeSourceCommit = sourceCommit;
const output = join(base, 'full-results');
const control = join(base, 'full-control');
const WINDOW_MS = 1200000;
const POLL_MS = 500;
const RSS_CAP_BYTES = 2 * 1024 ** 3;
const OUTPUT_CAP_BYTES = 256 * 1024 ** 2;
const HOST_RESERVE_BYTES = 1024 ** 3;
const CLEANUP_MS = 5000;
const startedAt = new Date().toISOString(), began = performance.now();
assert.equal(process.execPath, node, 'Use the pinned Node executable');
assert.equal(process.version, 'v22.23.3');
assert.equal(process.platform, 'linux', 'This controller uses Linux process groups and /proc');
assert.ok(!existsSync(control) && !existsSync(output), 'Refusing to overwrite a prior full attempt');
mkdirSync(control);
const writeJSON = (name, value) => writeFileSync(join(control, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const observations = join(control, 'observations.jsonl');
const pins = readFileSync(join(base, 'FULL-INPUTS.sha256'), 'utf8').trim().split('\n').map(line => {
  const match = /^([a-f\d]{64})  (\/.*)$/.exec(line);
  assert.ok(match, 'Input pins must contain absolute paths');
  return { sha256: match[1], path: match[2] };
});
function verifyPins() {
  for (const pin of pins) assert.equal(createHash('sha256').update(readFileSync(pin.path)).digest('hex'), pin.sha256, `Frozen input changed: ${pin.path}`);
}
function hostMemory() {
  return memoryHeadroom(path => readFileSync(path, 'utf8'));
}
function evidenceBytes(directory) {
  if (!existsSync(directory)) return 0;
  let sum = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected evidence symlink: ${path}`);
    if (entry.isDirectory()) sum += evidenceBytes(path);
    else if (entry.isFile()) sum += statSync(path).size;
    else throw new Error(`Unexpected evidence file type: ${path}`);
  }
  return sum;
}
function groupMembers(groupId) {
  if (!groupId) return [];
  const members = [];
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const stat = readFileSync(`/proc/${entry.name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      if (Number(fields[2]) !== groupId) continue;
      const status = readFileSync(`/proc/${entry.name}/status`, 'utf8');
      const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
      assert.ok(rss || fields[0] === 'Z', `Missing RSS for active group process ${entry.name}`);
      members.push({ pid: Number(entry.name), parentPid: Number(fields[1]), groupId, state: fields[0], rssBytes: rss ? Number(rss[1]) * 1024 : 0 });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return members.sort((left, right) => left.pid - right.pid);
}
let child, groupId, trigger, timer, observer, peakGroupRSSBytes = 0, peakEvidenceBytes = 0;
let cleanup, processReceipt;
const killEvents = [];
function killGroup(reason) {
  if (!groupId) return;
  const event = { at: new Date().toISOString(), groupId, signal: 'SIGKILL', reason };
  try { process.kill(-groupId, 'SIGKILL'); event.result = 'sent'; }
  catch (error) { event.result = error.code === 'ESRCH' ? 'already-gone' : 'failed'; event.error = error.message; }
  killEvents.push(event);
}
function stop(reason, detail) {
  if (trigger) return;
  trigger = { reason, at: new Date().toISOString(), elapsedMs: performance.now() - began, detail };
  killGroup(reason);
}
function observe() {
  try {
    const members = groupMembers(groupId), host = hostMemory();
    const rssBytes = members.reduce((sum, member) => sum + member.rssBytes, 0);
    const outputBytes = evidenceBytes(output) + evidenceBytes(control);
    peakGroupRSSBytes = Math.max(peakGroupRSSBytes, rssBytes); peakEvidenceBytes = Math.max(peakEvidenceBytes, outputBytes);
    const value = { at: new Date().toISOString(), elapsedMs: performance.now() - began, groupId, members, rssBytes, outputBytes, host, controllerRSSBytes: process.memoryUsage.rss() };
    appendFileSync(observations, JSON.stringify(value) + '\n');
    if (rssBytes > RSS_CAP_BYTES) stop('process-group-rss-cap', value);
    else if (outputBytes > OUTPUT_CAP_BYTES) stop('combined-evidence-output-cap', value);
    else if (host.effectiveHeadroomBytes < HOST_RESERVE_BYTES) stop('effective-memory-reserve', value);
  } catch (error) { stop('monitor-error', { message: error.message, stack: error.stack, memoryObservation: error.memoryObservation ?? null }); }
}
async function cleanupGroup() {
  const first = groupMembers(groupId), beganCleanup = performance.now();
  if (first.length) killGroup('terminal-cleanup');
  let final = first;
  while (final.length && performance.now() - beganCleanup < CLEANUP_MS) {
    await new Promise(resolve => setTimeout(resolve, 100));
    final = groupMembers(groupId);
  }
  return { at: new Date().toISOString(), groupId: groupId ?? null, first, final, empty: final.length === 0, observationBudgetMs: CLEANUP_MS, elapsedMs: performance.now() - beganCleanup, killEvents };
}

try {
  verifyPins();
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(git.status, 0); assert.equal(git.stdout.trim(), sourceCommit, 'Checkout HEAD changed since review');
  const host = hostMemory();
  if (host.effectiveHeadroomBytes < RSS_CAP_BYTES + HOST_RESERVE_BYTES) {
    const error = new Error('Require at least 3 GiB effective host/cgroup headroom before launch');
    error.memoryObservation = { state: 'insufficient-headroom', requiredHeadroomBytes: RSS_CAP_BYTES + HOST_RESERVE_BYTES, observed: host };
    throw error;
  }
  const args = ['proofs/feature-map-memory.mjs'];
  const overrides = { NODE_OPTIONS: '', FEATURE_MEMORY_SMOKE: '0', FEATURE_MEMORY_VENDOR: '', FEATURE_MEMORY_ENTRIES: '100000', FEATURE_MEMORY_TRIALS: '3',
    FEATURE_MEMORY_READERS: '0,2,4', FEATURE_MEMORY_KINDS: 'shared,native,immutable,immer', FEATURE_MEMORY_RUNTIME_SOURCE: runtimeSourceCommit, FEATURE_MEMORY_OUT: output };
  writeJSON('plan.json', { startedAt, command: node, args, cwd: root, environmentOverrides: overrides, sourceCommit, runtimeSourceCommit, pins, host,
    plannedRuns: 36, windowMs: WINDOW_MS, pollMs: POLL_MS, rssCapBytes: RSS_CAP_BYTES, combinedEvidenceCapBytes: OUTPUT_CAP_BYTES, hostReserveBytes: HOST_RESERVE_BYTES,
    note: 'Memory/output guards are externally polled; a sub-poll transient or output overshoot is possible. Effective reserve is the minimum of host availability and observable own/ancestor cgroup hard-limit headroom. Missing or restricted counters fail closed. Partial evidence is preserved on all stops.' });
  const stdout = openSync(join(control, 'driver.stdout.log'), 'wx'), stderr = openSync(join(control, 'driver.stderr.log'), 'wx');
  let status, signal, spawnError;
  const launchedAt = new Date().toISOString();
  try {
    child = spawn(node, args, { cwd: root, detached: true, stdio: ['ignore', stdout, stderr], env: { ...process.env, ...overrides } });
    groupId = child.pid;
    writeJSON('launch.json', { launchedAt, pid: child.pid ?? null, processGroupId: groupId ?? null, command: node, args, cwd: root, timeoutMs: Math.max(0, WINDOW_MS - (performance.now() - began)) });
    timer = setTimeout(() => stop('whole-window-timeout', { windowMs: WINDOW_MS }), Math.max(0, WINDOW_MS - (performance.now() - began)));
    observer = setInterval(observe, POLL_MS);
    observe();
    await new Promise(resolve => {
      child.on('error', error => { spawnError = { message: error.message, code: error.code }; });
      child.on('close', (code, terminationSignal) => { status = code; signal = terminationSignal; resolve(); });
    });
    clearTimeout(timer); clearInterval(observer);
  } finally { closeSync(stdout); closeSync(stderr); }
  observe();
  cleanup = await cleanupGroup();
  processReceipt = { launchedAt, endedAt: new Date().toISOString(), pid: child.pid ?? null, processGroupId: groupId ?? null, status, signal, spawnError: spawnError ?? null,
    trigger: trigger ?? null, peakGroupRSSBytes, peakEvidenceBytes, cleanup };
  writeJSON('driver.exit.json', processReceipt);
  observe();
  assert.ok(!trigger && !spawnError && status === 0 && cleanup.empty, 'Full run did not finish within the reviewed guards with an empty process group');
  assert.ok(performance.now() - began < WINDOW_MS, 'Whole window expired during terminal verification');
  verifyPins();
  const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'verified'); assert.equal(summary.runCount, 36); assert.equal(summary.entries, 100000); assert.equal(summary.trials, 3);
  assert.equal(summary.recordingType, 'full-matrix'); assert.equal(summary.chartEligible, true); assert.equal(summary.summary.length, 60);
  assert.deepEqual([...summary.kinds].sort(), ['immer', 'immutable', 'native', 'shared']); assert.deepEqual(summary.readerCounts, [0, 2, 4]);
  assert.ok(performance.now() - began < WINDOW_MS, 'Whole window expired while verifying final inputs and summary');
  const terminal = { status: 'verified', startedAt, endedAt: new Date().toISOString(), elapsedMs: performance.now() - began,
    verifiedRuns: 36, chartEligible: true, trigger: null, peakGroupRSSBytes, peakEvidenceBytes, cleanup };
  const finalEvidenceBytes = evidenceBytes(output) + evidenceBytes(control) + Buffer.byteLength(JSON.stringify(terminal, null, 2) + '\n');
  if (finalEvidenceBytes > OUTPUT_CAP_BYTES) stop('combined-evidence-output-cap', { finalEvidenceBytes, capBytes: OUTPUT_CAP_BYTES });
  assert.ok(!trigger, 'Final evidence exceeds its declared ceiling');
  writeJSON('terminal.json', terminal);
  process.stdout.write(`Verified 36 full-matrix processes; evidence retained in ${output} and ${control}\n`);
} catch (error) {
  clearTimeout(timer); clearInterval(observer);
  if (groupId && !cleanup) {
    killGroup('controller-failure');
    try { cleanup = await cleanupGroup(); } catch (cleanupError) { cleanup = { empty: false, error: cleanupError.stack ?? String(cleanupError), killEvents }; }
  }
  writeJSON('terminal.json', { status: 'failed', startedAt, endedAt: new Date().toISOString(), elapsedMs: performance.now() - began, chartEligible: false,
    trigger: trigger ?? null, processReceipt: processReceipt ?? null, peakGroupRSSBytes, peakEvidenceBytes, cleanup: cleanup ?? { empty: true, groupId: null },
    memoryObservation: error.memoryObservation ?? null, error: error.stack ?? String(error) });
  process.exitCode = 1;
  process.stderr.write(String(error.stack ?? error) + '\n');
}
