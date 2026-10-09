// Browser-only owner-scoped supervision. Ordinary prerequisite commands retain their audited supervisor.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runBoundedCommand as originalRun } from './heap-portability-process.mjs';
import { INFRASTRUCTURE } from './heap-repair-screen-budget.mjs';
export const NATIVE_CLEANUP_MS = INFRASTRUCTURE.nativeCleanupMs;
export async function runBoundedCommand(command, args, cwd, fd, timeoutMs, options = {}) {
 if (!options.nativeScope) return originalRun(command, args, cwd, fd, timeoutMs, options);
 assert(options.receiptPath && !existsSync(options.receiptPath), 'Fresh native lifetime receipt required');
 const requestPath = options.receiptPath + '.request.json';
 const request = { command: [command, ...args], cwd, env: options.env ?? process.env, timeoutMs,
  cleanupTimeoutMs: NATIVE_CLEANUP_MS, receiptPath: options.receiptPath, nativeScope: options.nativeScope };
 // Only task-local execution environment; no credentials are copied into request artifacts.
 // The child inherits the controller environment directly; its envelope stores only explicit additions.
 const saved = { ...request, env: undefined };
 writeFileSync(requestPath, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx' });
 const supervisor = fileURLToPath(new URL('./heap-repair-screen-supervisor.py', import.meta.url));
 return new Promise(resolve => {
  const child = spawn('python3', ['-I', '-S', supervisor, requestPath], { cwd, detached: true, env: request.env, stdio: ['ignore', fd, options.stderrFd ?? fd] });
  let error = null, interrupted = null, watchdog = false;
  const stop = reason => { interrupted ??= reason; if (child.pid) { try { child.kill('SIGTERM'); } catch (cause) { if (cause.code !== 'ESRCH') error ??= String(cause); } } };
  const onTerm = () => stop('SIGTERM'), onInt = () => stop('SIGINT'), onAbort = () => stop(String(options.signal.reason ?? 'aborted'));
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt); options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  // This is an infrastructure failsafe, not additional subject work time.
  const timer = setTimeout(() => { watchdog = true; stop('native-supervisor-watchdog'); }, timeoutMs + NATIVE_CLEANUP_MS + 5000);
  const hardTimer = setTimeout(() => { watchdog = true; error ??= 'Native supervisor failed its bounded cleanup envelope'; child.kill('SIGKILL'); }, timeoutMs + NATIVE_CLEANUP_MS + 10000);
  child.once('error', cause => { error = String(cause); });
  child.once('close', (status, signal) => {
   clearTimeout(timer); clearTimeout(hardTimer); process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); options.signal?.removeEventListener('abort', onAbort);
   let native;
   try { native = JSON.parse(readFileSync(options.receiptPath, 'utf8')); } catch (cause) { error ??= String(cause); }
   if (status !== 0 || signal) error ??= `Native supervisor exit ${status}/${signal}`;
   const receipt = native ? { status: native.status, signal: native.signal, error: native.error ?? error, timedOut: native.timedOut || watchdog,
    interrupted: native.interrupted ?? interrupted, cleanup: native.cleanup, nativeLifetime: native, nativeReceiptPath: options.receiptPath } :
    { status: null, signal, error, timedOut: watchdog, interrupted, cleanup: { status: 'unverified', group: null, survivors: [], reason: 'Native ownership/cleanup receipt missing' } };
   if (!native?.finishedAtUnixSeconds) { receipt.error ??= 'Native supervisor did not seal its lifetime receipt'; receipt.cleanup = { ...receipt.cleanup, status: 'unverified' }; }
   resolve(receipt);
  });
 });
}
export function validateNativeLifetime(receipt, processIdentity) {
 const native = receipt.nativeLifetime; assert(native, 'Missing owner-scoped native lifetime receipt');
 assert.equal(native.subreaper?.enabled, true); assert.equal(native.subreaper.verifiedBeforeOwnerSpawn, true);
 assert.equal(native.ownerPid, receipt.cleanup.group); assert.equal(native.cleanup.status, 'verified-no-live-processes');
 assert.deepEqual(native.cleanup.survivors, []); assert.deepEqual(native.cleanup.nativeGroupSurvivors, []);
 assert.equal(native.cleanup.ownerReaped, true); assert(native.cleanup.clearObservations >= 2);
 assert.equal(native.cleanup.forcedNativeTermination, false, 'Successful subject required forced native cleanup');
 assert.deepEqual(native.checkpoints.map(row => row.checkpoint), ['after-launch', 'before-work', 'after-work']);
 assert.deepEqual(native.checkpoints.map(row => ({ checkpoint: row.checkpoint, ...row.receipt })), processIdentity);
 for (const checkpoint of processIdentity) for (const row of checkpoint.observed) {
  assert(native.observed.some(owned => owned.pid === row.pid && owned.startTicks === row.startTicks && owned.pgid === row.pgid && owned.executableSha256 === row.executableSha256));
  assert(native.cleanup.nativeGroups.includes(row.pgid));
 }
 return true;
}
