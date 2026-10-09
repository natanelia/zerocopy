// Real benign Node descendants, no browser and no performance workload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runBoundedCommand } from './heap-repair-screen-process.mjs';
import { processTable } from './heap-repair-screen-engine.mjs';
const lifetime = fileURLToPath(new URL('./heap-repair-screen-lifetime.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => processTable().some(row => row.pid === pid);
const owners = `import { spawn, execFileSync } from 'node:child_process'; import { writeFileSync,readFileSync } from 'node:fs'; import { createHash } from 'node:crypto';
import { persistNativeCheckpoint } from ${JSON.stringify(new URL('./heap-repair-screen-lifetime.mjs', import.meta.url).href)};
const [mode,path] = process.argv.slice(2);
const code = mode === 'double-detach' ? \`import { spawn, execFileSync } from 'node:child_process'; import { writeFileSync } from 'node:fs'; const nested=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); writeFileSync(process.argv[1],String(nested.pid)); process.exit(0);\` : 'setInterval(()=>{},1000)';
const child=spawn(process.execPath,['--input-type=module','-e',code,path],{detached:true,stdio:'ignore'});
writeFileSync(path,String(child.pid));
if(mode==='exit-before-ready') process.exit(23);
if(mode==='double-detach') child.once('exit',()=>process.exit(23));
if(mode==='normal-checkpoints') {
 const stat=readFileSync('/proc/'+child.pid+'/stat','utf8'), f=stat.slice(stat.lastIndexOf(')')+2).split(' ');
 const row={pid:child.pid,ppid:process.pid,pgid:Number(f[2]),session:Number(f[3]),startTicks:f[19],executable:process.execPath,executableSha256:createHash('sha256').update(readFileSync(process.execPath)).digest('hex')};
 for(const checkpoint of ['after-launch','before-work','after-work']) persistNativeCheckpoint(checkpoint,{ownerPid:process.pid,distributionManifestSha256:'fixture',observed:[row]});
 child.once('exit',()=>process.exit(0)); child.kill('SIGTERM');
} else if(mode==='leak-success') process.exit(0); else setInterval(()=>{},1000);
`;
async function fixture(mode, { signal, timeoutMs = 3000, onStarted } = {}) {
 const directory = mkdtempSync(join(tmpdir(), 'heap-native-subreaper-')); const owner = join(directory, 'owner.mjs'), pidPath = join(directory, 'native.pid'); writeFileSync(owner, owners);
 const out = openSync(join(directory, 'out.log'), 'wx'), err = openSync(join(directory, 'err.log'), 'wx');
 const request = runBoundedCommand(process.execPath, [owner, mode, pidPath], directory, out, timeoutMs, { stderrFd: err, signal, env: { ...process.env, NODE_OPTIONS: '' }, receiptPath: join(directory, 'native.json'), nativeScope: { root: dirname(process.execPath), manifestSha256: 'fixture' } });
 let pid;
 try {
  if (onStarted) { const end = Date.now() + 2500; while (!existsSync(pidPath) && Date.now() < end) await delay(10); assert(existsSync(pidPath)); onStarted(); }
  const receipt = await request; pid = Number(readFileSync(pidPath, 'utf8'));
  return { receipt, pid, alive: alive(pid), receiptBytes: readFileSync(join(directory, 'native.json'), 'utf8') };
 } finally {
  closeSync(out); closeSync(err);
  if (!pid && existsSync(pidPath)) pid = Number(readFileSync(pidPath, 'utf8'));
  if (pid && alive(pid)) { process.kill(pid, 'SIGKILL'); await delay(50); }
  rmSync(directory, { recursive: true, force: true });
 }
}
test('launch-before-ready owner failure retains and closes its detached native group', async () => {
 const { receipt, pid, alive: remains } = await fixture('exit-before-ready');
 assert.equal(receipt.status, 23); assert.equal(receipt.cleanup.status, 'verified-no-live-processes'); assert.equal(remains, false);
 assert.equal(receipt.nativeLifetime.checkpoints.length, 0); assert(receipt.cleanup.nativeGroups.includes(pid)); assert.notEqual(pid, receipt.cleanup.group);
 assert(receipt.nativeLifetime.observed.some(row => row.pid === pid && row.startTicks && row.pgid === pid)); assert.equal(receipt.cleanup.forcedNativeTermination, true);
});
test('subject timeout before a complete receipt closes detached descendants without a retry', async () => {
 const { receipt, alive: remains } = await fixture('timeout', { timeoutMs: 1000 });
 assert.equal(receipt.timedOut, true); assert.equal(receipt.cleanup.status, 'verified-no-live-processes'); assert.equal(remains, false); assert.equal(receipt.nativeLifetime.checkpoints.length, 0);
});
test('interruption closes only owner-scoped descendants and leaves an unrelated detached process alive', async () => {
 const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
 try {
  const controller = new AbortController();
  const { receipt, pid, alive: remains } = await fixture('interrupted', { signal: controller.signal, onStarted: () => controller.abort('fixture-abort') });
  assert.equal(remains, false); assert.equal(receipt.cleanup.status, 'verified-no-live-processes'); assert(receipt.interrupted);
  assert(alive(unrelated.pid)); assert(!receipt.nativeLifetime.observed.some(row => row.pid === unrelated.pid)); assert.notEqual(unrelated.pid, pid);
 } finally { unrelated.kill('SIGKILL'); await new Promise(resolve => unrelated.once('exit', resolve)); }
});
test('native checkpoint acknowledgements follow persisted ownership and normal closure needs no kill', async () => {
 const { receipt, alive: remains, receiptBytes } = await fixture('normal-checkpoints');
 assert.equal(receipt.error, null); assert.equal(receipt.status, 0); assert.equal(remains, false); assert.equal(receipt.cleanup.forcedNativeTermination, false);
 assert.deepEqual(receipt.nativeLifetime.checkpoints.map(row => row.checkpoint), ['after-launch', 'before-work', 'after-work']);
 assert.deepEqual(JSON.parse(receiptBytes), receipt.nativeLifetime); assert.equal(receipt.nativeLifetime.subreaper.verifiedBeforeOwnerSpawn, true);
});
test('a nominal successful owner that leaves native processes is retained as abnormal failure', async () => {
 const { receipt, alive: remains } = await fixture('leak-success');
 assert.equal(receipt.status, 0); assert.match(receipt.error, /native descendants still live/); assert.equal(remains, false); assert.equal(receipt.cleanup.forcedNativeTermination, true);
});
test('double-detached grandchildren remain scoped after both immediate ancestors exit', async () => {
 const { receipt, pid, alive: remains } = await fixture('double-detach');
 assert.equal(receipt.status, 23); assert.equal(remains, false); assert.equal(receipt.cleanup.status, 'verified-no-live-processes');
 assert(receipt.nativeLifetime.observed.some(row => row.pid === pid && row.ppid === receipt.nativeLifetime.supervisorPid));
 assert(receipt.cleanup.nativeGroups.includes(pid));
});
test('cleanup deadline cannot certify one empty observation or an unreaped owner', () => {
 const source = fileURLToPath(new URL('./heap-repair-screen-supervisor.py', import.meta.url));
 const script = "import ast,json,sys; tree=ast.parse(open(sys.argv[1]).read()); function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='cleanup_verified'); scope={}; exec(compile(ast.Module(body=[function],type_ignores=[]),'frozen-cleanup-decision','exec'),scope); check=scope['cleanup_verified']; print(json.dumps([check(None,2,[],[]),check(0,1,[],[]),check(0,2,[],[]),check(0,2,[1],[]),check(0,2,[],[1])]))";
 assert.deepEqual(JSON.parse(execFileSync('python3', ['-I', '-S', '-c', script, source], { encoding: 'utf8' })), [false, false, true, false, false]);
});
