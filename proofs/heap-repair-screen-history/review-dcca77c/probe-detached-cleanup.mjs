// Browser-free lifecycle probe. No performance measurement or source modification.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBoundedCommand, processGroupMembers } from '/workspace/scratch/e7ec22ef2609/zerocopy-heap-repair-screen-20261009/proofs/heap-portability-process.mjs';

const directory = mkdtempSync(join(tmpdir(), 'heap-review-detached-'));
const pidFile = join(directory, 'descendant.pid');
const ownerFile = join(directory, 'owner.mjs');
const fd = openSync(join(directory, 'command.log'), 'wx');
const abort = new AbortController();
let descendantPid;
try {
  writeFileSync(ownerFile, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10000); setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`);
  const completion = runBoundedCommand(process.execPath, [ownerFile], directory, fd, 5000, { signal: abort.signal });
  const expires = Date.now() + 3000;
  while (!existsSync(pidFile)) {
    assert(Date.now() < expires, 'Probe owner did not start');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  descendantPid = Number(readFileSync(pidFile, 'utf8'));
  abort.abort('deterministic reviewer cancellation');
  const receipt = await completion;
  const survivorsOutsideReportedGroup = processGroupMembers(descendantPid).filter(row => !['Z', 'X'].includes(row.state));
  assert.equal(receipt.cleanup.status, 'verified-no-live-processes');
  assert(survivorsOutsideReportedGroup.some(row => row.pid === descendantPid));
  console.log(JSON.stringify({ receipt, descendantPid, survivorsOutsideReportedGroup, finding: 'Supervisor reports clean while detached descendant remains live' }, null, 2));
} finally {
  if (descendantPid) {
    try { process.kill(-descendantPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const expires = Date.now() + 2000;
    while (processGroupMembers(descendantPid).some(row => !['Z', 'X'].includes(row.state))) {
      assert(Date.now() < expires, 'Reviewer could not close probe descendant');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  closeSync(fd);
  rmSync(directory, { recursive: true, force: true });
}
