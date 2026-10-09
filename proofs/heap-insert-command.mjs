/** Bounded command core adapted from the tested radix prerequisite runner.
 * Original cleanup/core SHA-256: 2a8a5e0b5a48cedd9d2e99cdaf62d3377613714214acd46326fc58da9dee6746
 * Adaptation only adds env/separate stderr; the wrapper retains heap deadlines.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export const COMMAND_LIMITS = Object.freeze({ metadataMs: 30000, buildMs: 180000, testMs: 600000,
  typecheckMs: 120000, packageMs: 180000, workersMs: 180000, subjectMs: 120000 });
const PREREQUISITE_TIMEOUT_MS = 300000;
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
    const child = spawn(command, args, { cwd, env: options.env ?? process.env, detached: true, stdio: ['ignore', fd, options.stderrFd ?? fd] });
    let timedOut = false, interrupted = null, error = null;
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (cause) { if (cause.code !== 'ESRCH') error ??= String(cause); }
    };
    const interrupt = signal => { interrupted ??= signal; stop(); };
    const onTerm = () => interrupt('SIGTERM'), onInt = () => interrupt('SIGINT');
    process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.once('error', cause => { error = String(cause); });
    child.once('close', async (status, signal) => {
      // A shell may exit while descendants still hold the raw log descriptor.
      // End its whole group before hashing or archiving the command's evidence.
      stop(); clearTimeout(timer);
      let cleanup;
      try { cleanup = child.pid ? await verifyGroupCleanup(child.pid) : { status: 'not-started', group: null, members: [], survivors: [], timeoutMs: CLEANUP_TIMEOUT_MS }; }
      catch (cause) { error ??= String(cause); cleanup = { status: 'failed', group: child.pid ?? null, error: String(cause), timeoutMs: CLEANUP_TIMEOUT_MS }; }
      process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
      resolve({ status, signal, error, timedOut, interrupted, cleanup });
    });
  });
}

export async function runCommand({ name, command, args = [], cwd, env = process.env, prefix, timeoutMs }) {
  assert.equal(process.platform, 'linux', 'The gate requires Linux owned process groups');
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  mkdirSync(dirname(prefix), { recursive: true });
  const result = { name, command, args, cwd, timeoutMs, maximumCleanupMs: CLEANUP_TIMEOUT_MS,
    started: new Date().toISOString(), stdout: prefix + '.stdout.log', stderr: prefix + '.stderr.log',
    metadata: prefix + '.command.json', complete: false, status: null, signal: null, timedOut: false,
    interruptedSignal: null, cleanup: null };
  const persist = () => writeFileSync(result.metadata, JSON.stringify(result, null, 2) + '\n');
  const out = openSync(result.stdout, 'wx'), err = openSync(result.stderr, 'wx');
  persist();
  console.log(`[start] ${name}: deadline ${timeoutMs} ms; stdout ${result.stdout}; stderr ${result.stderr}`);
  try {
    Object.assign(result, await runBoundedCommand(command, args, cwd, out, timeoutMs, { env, stderrFd: err }));
    result.interruptedSignal = result.interrupted;
    result.complete = result.status === 0 && !result.signal && !result.timedOut && !result.interruptedSignal
      && !result.error && result.cleanup?.status === 'verified-no-live-processes';
  } catch (error) { result.error = String(error.stack ?? error); }
  finally {
    closeSync(out); closeSync(err); result.finished = new Date().toISOString(); persist();
    console.log(`[finish] ${name}: status ${result.status}; signal ${result.signal}; timeout ${result.timedOut}; cleanup ${result.cleanup?.status}`);
  }
  return result;
}
