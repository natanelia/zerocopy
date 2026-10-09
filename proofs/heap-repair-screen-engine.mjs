// Untimed distribution and live /proc binding. Never infer native identity from a launcher hash alone.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, realpathSync, readlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { json, sha256, manifest } from './heap-repair-screen-source.mjs';
const sorted = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const inside = (root, path) => path.startsWith(root + sep);
export function installedBrowserManifest(executable, readBuildId = path => {
 const output = execFileSync('readelf', ['-n', path], { encoding: 'utf8', timeout: 10000 });
 return output.match(/Build ID: ([0-9a-f]+)/)?.[1] ?? null;
}) {
 const root = realpathSync(dirname(executable)), entries = {}, native = {};
 function visit(directory) {
  for (const name of readdirSync(directory)) {
   const path = join(directory, name), key = relative(root, path), stat = lstatSync(path);
   if (stat.isDirectory()) { entries[key] = { type: 'directory', mode: stat.mode & 0o7777 }; visit(path); }
   else if (stat.isSymbolicLink()) {
    const target = realpathSync(path); assert(inside(root, target), `External distribution symlink ${key}`);
    entries[key] = { type: 'symlink', mode: stat.mode & 0o7777, target: readlinkSync(path), resolved: relative(root, target) };
   } else {
    assert(stat.isFile()); const bytes = readFileSync(path);
    entries[key] = { type: 'file', size: bytes.length, mode: stat.mode & 0o7777, sha256: sha256(bytes) };
    if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) native[key] = { ...entries[key], buildId: readBuildId(path) };
   }
  }
 }
 visit(root); const resolved = realpathSync(executable); assert(inside(root, resolved));
 assert(native['firefox'] || native['firefox-bin'], 'No native Firefox executable'); assert(native['libxul.so'], 'Missing native libxul');
 for (const name of ['application.ini', 'platform.ini']) assert(entries[name]?.type === 'file', `Missing ${name}`);
 const result = { root, executable: { requested: executable, resolved, relative: relative(root, resolved), sha256: sha256(readFileSync(resolved)) }, entries: sorted(entries), native: sorted(native),
  versionReceipts: Object.fromEntries(['application.ini', 'platform.ini'].map(name => [name, readFileSync(join(root, name), 'utf8')])),
  scope: 'Complete installed Firefox distribution. Host system libraries are outside distribution provenance and separately labeled when observed.' };
 assert.match(result.versionReceipts['application.ini'], /(?:^|\n)Version=155\.0(?:\n|$)/);
 assert.match(result.versionReceipts['platform.ini'], /(?:^|\n)BuildID=\d+(?:\n|$)/);
 result.manifestSha256 = sha256(JSON.stringify(result.entries)); return result;
}
export async function engineIdentity() {
 const bunPath = realpathSync(execFileSync('bun', ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 10000 }).trim());
 const bun = { path: bunPath, sha256: sha256(readFileSync(bunPath)), version: execFileSync(bunPath, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(), revision: execFileSync(bunPath, ['-p', 'Bun.revision'], { encoding: 'utf8', timeout: 10000 }).trim() };
 assert.equal(bun.version, '1.4.2'); assert.equal(bun.revision, '744846f844374847c902b5e7fd59b4342a51ef99');
 const controller = { path: realpathSync(process.execPath), sha256: sha256(readFileSync(process.execPath)), version: process.versions.node, execArgv: process.execArgv };
 assert.equal(controller.version, '22.23.3'); assert.deepEqual(controller.execArgv, []);
 const packages = Object.fromEntries(['playwright', 'playwright-core'].map(name => {
  const path = fileURLToPath(new URL(`../node_modules/${name}/`, import.meta.url)), files = manifest(realpathSync(path));
  assert.equal(json(join(path, 'package.json')).version, '1.63.0'); return [name, { files, sha256: sha256(JSON.stringify(files)) }];
 }));
 const bytes = readFileSync(new URL('../node_modules/playwright-core/browsers.json', import.meta.url)), browsersJsonSha256 = sha256(bytes);
 assert.equal(browsersJsonSha256, json(new URL('./heap-portability-pins.json', import.meta.url)).playwright.browsersJsonSha256);
 const revision = JSON.parse(bytes).browsers.find(row => row.name === 'firefox'); assert.equal(revision.revision, '1543'); assert.equal(revision.browserVersion, '155.0');
 const python = JSON.parse(execFileSync('python3', ['-I', '-S', '-c', 'import sys,os,json; print(json.dumps({"path":os.path.realpath(sys.executable),"version":sys.version}))'], { encoding: 'utf8', timeout: 10000 }));
 const supervisor = { path: python.path, version: python.version, sha256: sha256(readFileSync(python.path)), sourceSha256: sha256(readFileSync(new URL('./heap-repair-screen-supervisor.py', import.meta.url))), flags: ['-I', '-S'] };
 const { firefox } = await import('playwright'); const installed = installedBrowserManifest(firefox.executablePath());
 const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:MOZ_|JS_|JIT_|LD_PRELOAD$|LD_LIBRARY_PATH$)/.test(key)).sort());
 assert.deepEqual(environment, {}, 'Non-default engine/environment overrides are excluded');
 return { controller, bun, supervisor, packages, playwright: '1.63.0', revision, browsersJsonSha256, installed, environment,
  launchOptions: { headless: true, timeout: 30000 }, firefoxSlots: { nfixed: null, nslots: null, allocationBytes: null, bucket: null, status: 'unmeasured; no supported exact-build inspection route used; effect-only scope' } };
}
export function processTable(procRoot = '/proc') {
 const rows = [];
 for (const name of readdirSync(procRoot)) {
  if (!/^[1-9][0-9]*$/.test(name)) continue;
  try { const stat = readFileSync(join(procRoot, name, 'stat'), 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
   if (!['Z', 'X'].includes(fields[0])) rows.push({ pid: Number(name), ppid: Number(fields[1]), pgid: Number(fields[2]), session: Number(fields[3]), startTicks: fields[19], state: fields[0] });
  } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
 }
 return rows.sort((a, b) => a.pid - b.pid);
}
export function bindProcessTree(ownerPid, identity, procRoot = '/proc') {
 const table = processTable(procRoot), descendants = new Set([ownerPid]);
 for (;;) { const before = descendants.size; table.forEach(row => { if (descendants.has(row.ppid)) descendants.add(row.pid); }); if (before === descendants.size) break; }
 const root = identity.installed.root;
 const browserRows = table.filter(row => row.pid !== ownerPid && descendants.has(row.pid));
 assert(browserRows.length > 0, 'No launched browser process observed');
 const observed = browserRows.map(row => {
  const path = join(procRoot, String(row.pid)); const executable = realpathSync(join(path, 'exe'));
  assert(inside(root, executable), `Launched descendant escapes frozen Firefox distribution: ${executable}`);
  const name = relative(root, executable), pinned = identity.installed.entries[name]; assert.equal(pinned?.type, 'file');
  assert.equal(sha256(readFileSync(executable)), pinned.sha256, 'Live executable bytes differ from frozen distribution');
  const argv = readFileSync(join(path, 'cmdline')).toString().split('\0').filter(Boolean); assert(argv.length > 0);
  const mappings = readFileSync(join(path, 'maps'), 'utf8').split('\n').filter(Boolean).map(line => line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/)?.[1]).filter(path => path?.startsWith('/'));
  const distributionLibraries = {}, hostLibrariesOutsideProvenance = [];
  for (const mapped of [...new Set(mappings)].sort()) {
   if (!inside(root, mapped)) { hostLibrariesOutsideProvenance.push(mapped); continue; }
   assert(!mapped.endsWith(' (deleted)'), 'Mapped distribution file deleted during provenance observation');
   const resolved = realpathSync(mapped);
   if (inside(root, resolved)) { const relativePath = relative(root, resolved), expected = identity.installed.entries[relativePath]; assert.equal(expected?.type, 'file'); assert.equal(sha256(readFileSync(resolved)), expected.sha256); distributionLibraries[relativePath] = expected.sha256; }
   else hostLibrariesOutsideProvenance.push(resolved);
  }
  return { ...row, executable, relativeExecutable: name, executableSha256: pinned.sha256, argv, distributionLibraries, hostLibrariesOutsideProvenance };
 });
 const main = observed.filter(row => row.ppid === ownerPid); assert.equal(main.length, 1, 'Ambiguous browser root');
 assert(['firefox', 'firefox-bin'].includes(main[0].relativeExecutable)); assert(main[0].argv.includes('-headless')); assert(main[0].argv.includes('-juggler-pipe'));
 assert(observed.some(row => row.distributionLibraries['libxul.so']), 'No actual mapped libxul linkage');
 const receipt = { ownerPid, browserPid: main[0].pid, distributionManifestSha256: identity.installed.manifestSha256, observed,
  coverage: 'Live process tree at this checkpoint only; transient processes between checkpoints are not claimed. Native root executable and mapped libxul must be present before work.' };
 validateProcessReceipt(receipt, identity); return receipt;
}

export function validateProcessReceipt(receipt, identity, ownerPid = receipt.ownerPid) {
 assert.equal(receipt.ownerPid, ownerPid); assert(Number.isSafeInteger(ownerPid) && ownerPid > 0);
 assert.equal(receipt.distributionManifestSha256, identity.installed.manifestSha256);
 assert(Array.isArray(receipt.observed) && receipt.observed.length > 0);
 const pids = new Set(receipt.observed.map(row => row.pid)); assert.equal(pids.size, receipt.observed.length);
 const roots = receipt.observed.filter(row => row.ppid === ownerPid); assert.equal(roots.length, 1); assert.equal(roots[0].pid, receipt.browserPid);
 for (const row of receipt.observed) {
  assert(Number.isSafeInteger(row.pid) && row.pid > 0); assert(/^\d+$/.test(row.startTicks));
  assert(Number.isSafeInteger(row.pgid) && row.pgid > 0); assert(Number.isSafeInteger(row.session) && row.session > 0);
  assert(row.ppid === ownerPid || pids.has(row.ppid), 'Unlinked browser descendant');
  assert.equal(row.executable, join(identity.installed.root, row.relativeExecutable));
  const pinned = identity.installed.entries[row.relativeExecutable]; assert.equal(pinned?.type, 'file'); assert.equal(row.executableSha256, pinned.sha256);
  assert(identity.installed.native[row.relativeExecutable], 'Observed executable is not a pinned ELF');
  assert(Array.isArray(row.argv) && row.argv.length > 0);
  for (const [name, hash] of Object.entries(row.distributionLibraries)) assert.equal(hash, identity.installed.entries[name]?.sha256);
 }
 assert(['firefox', 'firefox-bin'].includes(roots[0].relativeExecutable));
 assert.equal(roots[0].pgid, roots[0].pid, 'Firefox must lead its Playwright-detached native group');
 assert.equal(roots[0].session, roots[0].pid);
 const argv = roots[0].argv; assert.equal(argv.length, 7, 'Unexpected browser launch argument');
 assert.deepEqual([argv[1], argv[2], argv[3], argv[5], argv[6]], ['-no-remote', '-headless', '-profile', '-juggler-pipe', '-silent'], 'Firefox default flags changed');
 assert(argv[4].startsWith('/') && argv[4].split('/').at(-1).startsWith('playwright_firefoxdev_profile-'), 'Unexpected browser profile');
 assert(receipt.observed.some(row => row.distributionLibraries['libxul.so'] === identity.installed.entries['libxul.so'].sha256), 'No actual mapped libxul linkage');
 return true;
}
