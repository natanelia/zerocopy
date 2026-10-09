import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';

export const TEST_TIMEOUT_MS = 600000, CLEANUP_TIMEOUT_MS = 1000, SAMPLE_INTERVAL_MS = 2000;
export function save(file, value) {
  writeFileSync(file + '.pending', JSON.stringify(value, null, 2) + '\n');
  renameSync(file + '.pending', file);
}
export function parseStat(text) {
  const end = text.lastIndexOf(')'), f = text.slice(end + 2).trim().split(/\s+/);
  return { pid: Number(text.slice(0, text.indexOf(' '))), command: text.slice(text.indexOf('(') + 1, end),
    state: f[0], ppid: Number(f[1]), group: Number(f[2]), session: Number(f[3]),
    userTicks: Number(f[11]), systemTicks: Number(f[12]), threads: Number(f[17]), startTicks: Number(f[19]), rssPages: Number(f[21]) };
}
function maybeStat(file) {
  try { return parseStat(readFileSync(file, 'utf8')); }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
export function processGroupMembers(group) {
  return readdirSync('/proc').filter(p => /^[1-9][0-9]*$/.test(p)).map(p => maybeStat(`/proc/${p}/stat`))
    .filter(p => p && p.group === group).sort((a, b) => a.pid - b.pid);
}
export function sample(group, { members = processGroupMembers, stat = maybeStat, list = readdirSync, read = readFileSync } = {}) {
  const processes = members(group).map(info => {
    let ids;
    try { ids = list(`/proc/${info.pid}/task`); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; ids = []; }
    return { ...info, tasks: ids.map(id => stat(`/proc/${info.pid}/task/${id}/stat`)).filter(Boolean) };
  });
  return { timestamp: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString(),
    monitorPid: process.pid, monitorCpu: process.cpuUsage(), monitor: stat(`/proc/${process.pid}/stat`),
    group, processes, uptime: read('/proc/uptime', 'utf8').trim(), loadavg: read('/proc/loadavg', 'utf8').trim() };
}
export async function verifyCleanup(group) {
  const end = Date.now() + CLEANUP_TIMEOUT_MS;
  for (;;) {
    const members = processGroupMembers(group), survivors = members.filter(p => !['Z', 'X'].includes(p.state));
    if (!survivors.length || Date.now() >= end) return { status: survivors.length ? 'failed' : 'verified-no-live-processes',
      group, members, survivors, timeoutMs: CLEANUP_TIMEOUT_MS };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
export async function runCommand({ name, command, args, cwd, env = process.env, prefix, timeoutMs }) {
  assert.equal(process.platform, 'linux'); assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  const result = { name, command, args, cwd, timeoutMs, sampleIntervalMs: SAMPLE_INTERVAL_MS, complete: false,
    status: null, signal: null, timedOut: false, interrupted: null, error: null, started: new Date().toISOString(),
    stdout: prefix + '.stdout.log', stderr: prefix + '.stderr.log', samples: prefix + '.samples.jsonl' };
  const out = openSync(result.stdout, 'wx'), err = openSync(result.stderr, 'wx'), heartbeat = openSync(result.samples, 'wx');
  save(prefix + '.command.json', result);
  let child, deadline, sampler, stop;
  const interrupt = signal => { result.interrupted ??= signal; stop?.(); };
  const onTerm = () => interrupt('SIGTERM'), onInt = () => interrupt('SIGINT');
  const capture = event => {
    try { appendFileSync(heartbeat, JSON.stringify({ event, ...sample(child.pid) }) + '\n'); }
    catch (error) { result.error ??= `Sampler failed: ${error.stack ?? error}`; stop?.(); }
  };
  try {
    console.log(`[start] ${name}: ${timeoutMs} ms bound`);
    child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', out, err] });
    result.pid = child.pid ?? null;
    stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') result.error ??= String(error); }
    };
    process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
    save(prefix + '.command.json', result);
    await new Promise(resolve => {
      child.once('error', error => { result.error ??= String(error); resolve(); });
      child.once('exit', (status, signal) => { result.status = status; result.signal = signal; resolve(); });
      deadline = setTimeout(() => { result.timedOut = true; capture('deadline'); stop(); }, timeoutMs);
      sampler = setInterval(() => capture('sample'), SAMPLE_INTERVAL_MS);
      if (child.pid) capture('spawn');
    });
  } catch (error) { result.error ??= String(error.stack ?? error); }
  finally {
    clearTimeout(deadline); clearInterval(sampler); stop?.();
    try { result.cleanup = child?.pid ? await verifyCleanup(child.pid) : { status: 'not-started', group: null }; }
    catch (error) { result.cleanup = { status: 'failed', error: String(error) }; }
    if (child?.pid) capture('after-cleanup');
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
    closeSync(out); closeSync(err); closeSync(heartbeat);
    result.finished = new Date().toISOString();
    result.complete = result.status === 0 && !result.signal && !result.timedOut && !result.interrupted
      && !result.error && result.cleanup.status === 'verified-no-live-processes';
    save(prefix + '.command.json', result);
    console.log(`[finish] ${name}: status=${result.status} timeout=${result.timedOut} cleanup=${result.cleanup.status}`);
  }
  return result;
}
