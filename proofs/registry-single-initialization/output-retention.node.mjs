/** Synthetic subprocess tests only; no benchmark subject or timing workload. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { runToFiles } from './run-to-files.mjs';

test('failed child stdout/stderr are retained and existing evidence cannot be replaced', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-output-test-'));
  try {
    const options = { stdoutPath: join(root, 'out'), stderrPath: join(root, 'err'), timeout: 5000 };
    const result = runToFiles(process.execPath, ['-e', "require('fs').writeSync(1, 'completed event\\n'); require('fs').writeSync(2, 'failure details\\n'); process.exit(7);"], options);
    assert.equal(result.status, 7); assert.equal(result.stdout, 'completed event\n'); assert.equal(result.stderr, 'failure details\n');
    assert.equal(readFileSync(options.stdoutPath, 'utf8'), result.stdout);
    assert.throws(() => runToFiles(process.execPath, ['-e', ''], options), /EEXIST/);
    assert.equal(readFileSync(options.stdoutPath, 'utf8'), 'completed event\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('completed synchronous output survives controller interruption while its child is active', async () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-interruption-test-'));
  const stdoutPath = join(root, 'out'), stderrPath = join(root, 'err');
  const child = "const fs=require('fs'); fs.writeSync(1, JSON.stringify({event:'synthetic-start',pid:process.pid})+'\\n'); setTimeout(()=>{ fs.writeSync(1, JSON.stringify({event:'synthetic-end'})+'\\n'); }, 300);";
  const script = 'import { runToFiles } from ' + JSON.stringify(new URL('./run-to-files.mjs', import.meta.url).href) + '; runToFiles(process.execPath, ["-e", ' + JSON.stringify(child) + '], ' + JSON.stringify({ stdoutPath, stderrPath, timeout: 5000 }) + ');';
  const controller = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  let childPid;
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(stdoutPath) || !readFileSync(stdoutPath, 'utf8').includes('\n')) {
      assert(Date.now() < deadline, 'Synthetic child did not emit its first event'); await wait(5);
    }
    const first = JSON.parse(readFileSync(stdoutPath, 'utf8').split('\n')[0]); childPid = first.pid;
    assert.equal(first.event, 'synthetic-start');
    const exited = once(controller, 'exit'); assert.equal(controller.kill('SIGKILL'), true); await exited;
    assert.equal(JSON.parse(readFileSync(stdoutPath, 'utf8').split('\n')[0]).event, 'synthetic-start');
    while (!readFileSync(stdoutPath, 'utf8').includes('synthetic-end')) {
      assert(Date.now() < deadline, 'Synthetic child did not finish'); await wait(10);
    }
    assert.equal(readFileSync(stdoutPath, 'utf8').trim().split('\n').length, 2);
  } finally {
    if (controller.exitCode === null && controller.signalCode === null) controller.kill('SIGKILL');
    if (childPid) { try { process.kill(childPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    rmSync(root, { recursive: true, force: true });
  }
});
