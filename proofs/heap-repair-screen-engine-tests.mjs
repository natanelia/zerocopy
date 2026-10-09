import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedBrowserManifest, bindProcessTree, validateProcessReceipt } from './heap-repair-screen-engine.mjs';
function fixture() {
 const directory = mkdtempSync(join(tmpdir(), 'heap-firefox-identity-')), root = join(directory, 'firefox'), proc = join(directory, 'proc'); mkdirSync(root); mkdirSync(proc);
 const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]);
 for (const file of ['firefox', 'libxul.so']) writeFileSync(join(root, file), elf, { mode: 0o755 });
 writeFileSync(join(root, 'application.ini'), '[App]\nVersion=155.0\nBuildID=20261009000000\n'); writeFileSync(join(root, 'platform.ini'), '[Build]\nBuildID=20261009000000\n');
 const identity = { installed: installedBrowserManifest(join(root, 'firefox'), () => 'aabbcc') };
 const process = (pid, ppid, executable = join(root, 'firefox'), mapped = join(root, 'libxul.so')) => {
  const path = join(proc, String(pid)); mkdirSync(path); const fields = Array(22).fill('0'); fields[0] = 'S'; fields[1] = String(ppid); fields[2] = '11'; fields[3] = '11'; fields[19] = String(pid * 100); writeFileSync(join(path, 'stat'), `${pid} (firefox child) ${fields.join(' ')}`); symlinkSync(executable, join(path, 'exe'));
  writeFileSync(join(path, 'cmdline'), executable + '\0-no-remote\0-headless\0-profile\0/tmp/playwright_firefoxdev_profile-test\0-juggler-pipe\0-silent\0'); writeFileSync(join(path, 'maps'), `001-002 r-xp 0000 01:00 1 ${mapped}\n002-003 rw-p 0000 00:00 0 /memfd:mozilla-ipc (deleted)\n003-004 r-xp 0000 01:00 2 /usr/lib/libc.so\n`);
 }; process(10, 1); process(11, 10); process(12, 11);
 return { directory, root, proc, identity, process };
}
test('native distribution records modes sizes build IDs and real process linkage', () => {
 const f = fixture(); try {
  assert.equal(f.identity.installed.entries.firefox.size, 5); assert.equal(f.identity.installed.native['libxul.so'].buildId, 'aabbcc');
  const result = bindProcessTree(10, f.identity, f.proc); assert.equal(result.browserPid, 11); assert.deepEqual(result.observed.map(row => row.pid), [11, 12]); assert(result.observed[0].distributionLibraries['libxul.so']); assert(result.observed[0].hostLibrariesOutsideProvenance.includes('/memfd:mozilla-ipc (deleted)'));
 } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
test('launcher-only record, escaped child, changed library and missing native linkage fail closed', () => {
 for (const variant of ['escape', 'changed', 'missing', 'symlink']) {
  const f = fixture(); try {
   if (variant === 'escape') { f.process(13, 11, process.execPath); assert.throws(() => bindProcessTree(10, f.identity, f.proc), /escapes/); }
   if (variant === 'changed') { writeFileSync(join(f.root, 'libxul.so'), 'changed'); assert.throws(() => bindProcessTree(10, f.identity, f.proc)); }
   if (variant === 'missing') { for (const pid of [11, 12]) writeFileSync(join(f.proc, String(pid), 'maps'), ''); assert.throws(() => bindProcessTree(10, f.identity, f.proc), /No actual mapped libxul/); }
   if (variant === 'symlink') { symlinkSync(process.execPath, join(f.root, 'outside')); assert.throws(() => installedBrowserManifest(join(f.root, 'firefox'), () => null), /External distribution symlink/); }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
 }
});
test('retained process receipts reject wrong owner, forged bytes and unlinked descendants', () => {
 const f = fixture(); try {
  const receipt = bindProcessTree(10, f.identity, f.proc); assert(validateProcessReceipt(receipt, f.identity, 10));
  assert.throws(() => validateProcessReceipt(receipt, f.identity, 999));
  for (const mutate of [r => { r.observed[0].executableSha256 = 'f'.repeat(64); }, r => { r.observed[1].ppid = 999; }, r => { r.observed[0].executable = '/outside'; }, r => { r.observed[0].argv = ['-custom']; }]) {
   const changed = structuredClone(receipt); mutate(changed); assert.throws(() => validateProcessReceipt(changed, f.identity, 10));
  }
 } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
