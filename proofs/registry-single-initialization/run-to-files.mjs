/** Preserve child output as it is emitted, even if the controller is interrupted. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
export function runToFiles(executable, args, { stdoutPath, stderrPath, ...options }) {
  assert(stdoutPath && stderrPath && stdoutPath !== stderrPath);
  assert.equal(options.stdio, undefined, 'Direct evidence-file stdio cannot be overridden');
  let stdoutFd, stderrFd, result;
  try {
    stdoutFd = openSync(stdoutPath, 'wx'); stderrFd = openSync(stderrPath, 'wx');
    result = spawnSync(executable, args, { ...options, stdio: ['ignore', stdoutFd, stderrFd] });
  } finally {
    if (stderrFd !== undefined) closeSync(stderrFd);
    if (stdoutFd !== undefined) closeSync(stdoutFd);
  }
  return { ...result, stdout: readFileSync(stdoutPath, 'utf8'), stderr: readFileSync(stderrPath, 'utf8') };
}
