// Process-group supervisor copied unchanged from published radix proof ac7f07a.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
export const PREREQUISITE_TIMEOUT_MS = 300_000;
export const CLEANUP_TIMEOUT_MS = 1000;
export function processGroupMembers(group) {
  const members = [];
  for (const name of readdirSync('/proc')) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    let stat;
    try { stat = readFileSync(`/proc/${name}/stat`, 'utf8'); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[2]) === group) members.push({ pid: Number(name), state: fields[0] });
  }
  return members.sort((a, b) => a.pid - b.pid);
}
async function verifyGroupCleanup(group) {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  for (;;) {
    const members = processGroupMembers(group), survivors = members.filter(({ state }) => !['Z', 'X'].includes(state));
    if (!survivors.length) return { status: 'verified-no-live-processes', group, members, survivors, timeoutMs: CLEANUP_TIMEOUT_MS };
    if (Date.now() >= deadline) return { status: 'failed', group, members, survivors, timeoutMs: CLEANUP_TIMEOUT_MS };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
export function runBoundedCommand(command, args, cwd, fd, timeoutMs = PREREQUISITE_TIMEOUT_MS, options = {}) {
  assert.equal(process.platform, 'linux', 'Prerequisite process-group cleanup requires Linux');
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, detached: true, env: options.env ?? process.env, stdio: ['ignore', fd, options.stderrFd ?? fd] });
    let timedOut = false, interrupted = null, error = null;
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (cause) { if (cause.code !== 'ESRCH') error ??= String(cause); }
    };
    const interrupt = signal => { interrupted ??= signal; stop(); };
    const onTerm = () => interrupt('SIGTERM'), onInt = () => interrupt('SIGINT');
    const onAbort = () => interrupt(String(options.signal.reason ?? 'aborted'));
    process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.once('error', cause => { error = String(cause); });
    child.once('close', async (status, signal) => {
      // A shell may exit while descendants still hold the raw log descriptor.
      // End its whole group before hashing or archiving the command's evidence.
      stop(); clearTimeout(timer);
      let cleanup;
      try { cleanup = child.pid ? await verifyGroupCleanup(child.pid) : { status: 'not-started', group: null, members: [], survivors: [], timeoutMs: CLEANUP_TIMEOUT_MS }; }
      catch (cause) { error ??= String(cause); cleanup = { status: 'failed', group: child.pid ?? null, error: String(cause), timeoutMs: CLEANUP_TIMEOUT_MS }; }
      process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ status, signal, error, timedOut, interrupted, cleanup });
    });
  });
}
