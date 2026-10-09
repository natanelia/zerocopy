/** Owned-process pattern adapted from audited block-reuse-command.mjs.
 * Total command envelopes INCLUDE 50ms TERM grace and 150ms KILL/verification.
 * File-descriptor logs stream immediately. Only registered process groups are killed.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
export const CLEANUP = Object.freeze({ termMs: 50, verifyMs: 150, reserveMs: 200 });
const owned = new Map();
let interruptedSignal = null, cleanupFailure = false;
export const interruption = () => interruptedSignal;
export function atomicJSON(path, value) { writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n'); renameSync(`${path}.tmp`, path); }
export function processGroupMembers(group) {
  const members = [];
  for (const name of readdirSync('/proc')) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    let stat;
    try { stat = readFileSync(`/proc/${name}/stat`, 'utf8'); } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[2]) === group) members.push({ pid: Number(name), state: fields[0], parent: Number(fields[1]), startTicks: fields[19] });
  }
  return members.sort((a, b) => a.pid - b.pid);
}
const live = group => processGroupMembers(group).filter(p => !['Z', 'X'].includes(p.state));
function killGroup(group, signal) { try { process.kill(-group, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  interruptedSignal ??= signal; process.exitCode = signal === 'SIGTERM' ? 143 : 130;
  for (const entry of owned.values()) entry.stop(signal);
});
process.on('exit', () => {
  for (const [group, entry] of owned) {
    try { killGroup(group, 'SIGKILL'); entry.receipt.status = 'controller-exit-cleanup-unverified'; entry.persist(); } catch {}
  }
});
export function assertLaunchBudget(deadline, reserveMs = CLEANUP.reserveMs) {
  assert(!interruptedSignal, `Controller interrupted: ${interruptedSignal}`);
  assert(Number.isFinite(deadline) && deadline - Date.now() > reserveMs, 'engine-budget-exhausted');
}
export async function runOwnedCommand({ command, args = [], cwd, env = process.env, prefix, totalMs, deadline = Infinity, identity = {} }) {
  assert.equal(process.platform, 'linux');
  assertOwnedClean();
  assert(Number.isSafeInteger(totalMs) && totalMs > CLEANUP.reserveMs);
  const end = Math.min(Date.now() + totalMs, deadline);
  mkdirSync(dirname(prefix), { recursive: true });
  const receipt = { ...identity, command, args, cwd, totalMs, cleanupReserveMs: CLEANUP.reserveMs,
    deadline: end, controllerPid: process.pid, pid: null, group: null, status: 'planned', complete: false,
    stdout: `${prefix}.stdout.log`, stderr: `${prefix}.stderr.log`, metadata: `${prefix}.command.json` };
  const persist = () => atomicJSON(receipt.metadata, receipt);
  assert(!existsSync(receipt.metadata), 'Refuse to overwrite an existing launch receipt');
  persist(); // Durable slot exists before spawn, including failed/no-launch slots.
  try { assertLaunchBudget(end); } catch (error) { receipt.status = 'not-started-budget-or-interrupt'; receipt.error = String(error); persist(); return receipt; }
  const out = openSync(receipt.stdout, 'wx'), err = openSync(receipt.stderr, 'wx');
  let child, timer, exited = false, stoppingAt = null, cleanupDeadline = null, killSent = false;
  try {
    // Check again after receipt/log preparation. Never launch after staging expires.
    assertLaunchBudget(end);
    child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', out, err] });
    receipt.pid = child.pid ?? null; receipt.group = child.pid ?? null; receipt.status = 'running';
    if (child.pid) receipt.initialMembers = processGroupMembers(child.pid);
    const stop = reason => {
      if (stoppingAt !== null) return;
      stoppingAt = Date.now(); cleanupDeadline = Math.min(end, stoppingAt + CLEANUP.reserveMs);
      receipt.stopReason = reason; receipt.status = 'stopping';
      if (['SIGTERM', 'SIGINT'].includes(reason)) receipt.interrupted = reason;
      if (reason === 'command-cap') receipt.timedOut = true;
      if (child.pid) killGroup(child.pid, 'SIGTERM');
      persist();
    };
    if (child.pid) owned.set(child.pid, { receipt, persist, stop });
    persist(); // PID/group identity is on disk before awaiting the process.
    const result = await new Promise(resolve => {
      child.once('error', error => { receipt.error = String(error); exited = true; stop('spawn-error'); });
      child.once('exit', (code, signal) => { receipt.exitCode = code; receipt.signal = signal; exited = true; stop('child-exit'); });
      const finish = cleanup => {
        clearTimeout(timer); receipt.cleanup = cleanup;
        if (cleanup.status === 'failed') cleanupFailure = true;
        if (Date.now() > end) receipt.timedOut = true;
        receipt.complete = receipt.exitCode === 0 && !receipt.signal && !receipt.error && !receipt.timedOut && !receipt.interrupted && cleanup.status === 'verified-no-live-processes';
        receipt.status = receipt.complete ? 'complete' : cleanup.status === 'failed' ? 'cleanup-failed' : receipt.timedOut ? 'cap-invalid' : receipt.interrupted ? 'interrupted' : 'failed';
        if (child.pid && cleanup.status === 'verified-no-live-processes') owned.delete(child.pid);
        persist(); resolve(receipt);
      };
      const tick = () => {
        try {
          const now = Date.now();
          if (stoppingAt === null && now >= end - CLEANUP.reserveMs) stop('command-cap');
          if (stoppingAt !== null) {
            const survivors = child.pid ? live(child.pid) : [];
            if (!survivors.length && exited) return finish({ status: 'verified-no-live-processes', group: child.pid ?? null, survivors });
            if (!killSent && now >= Math.min(stoppingAt + CLEANUP.termMs, cleanupDeadline)) {
              if (child.pid) killGroup(child.pid, 'SIGKILL'); killSent = true; receipt.killSent = true; persist();
            }
            if (now >= cleanupDeadline) return finish({ status: survivors.length ? 'failed' : 'verified-no-live-processes', group: child.pid ?? null, survivors });
          }
          timer = setTimeout(tick, 5);
        } catch (error) { receipt.error = String(error); if (child.pid) killGroup(child.pid, 'SIGKILL'); finish({ status: 'failed', group: child.pid ?? null, error: String(error) }); }
      };
      timer = setTimeout(tick, 0);
    });
    return result;
  } catch (error) {
    receipt.error = String(error); receipt.status = child ? 'cleanup-unverified' : 'not-started-budget-or-interrupt';
    if (child?.pid) killGroup(child.pid, 'SIGKILL'); persist(); return receipt;
  } finally { clearTimeout(timer); closeSync(out); closeSync(err); }
}
export function assertOwnedClean() {
  const survivors = [...owned.keys()].flatMap(group => live(group));
  assert(!cleanupFailure, 'An owned-group cleanup failed; stop and preserve evidence');
  assert.equal(survivors.length, 0, `Owned live groups remain: ${JSON.stringify(survivors)}`);
}
