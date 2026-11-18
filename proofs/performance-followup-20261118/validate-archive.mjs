#!/usr/bin/env node
// Archive integrity and patch reconstruction only; never runs archived code.
// Usage: node validate-archive.mjs [--repo /git/repository] [--source /originals]
// Patch reconstruction uses disposable indexes. The working tree and real
// index are untouched; Git may retain reconstructed objects in its object DB.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const directory = dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (actual, expected, label) => assert.deepStrictEqual(actual, expected, label);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const objectId = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const normal = value => JSON.parse(JSON.stringify(value));
const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnv[key];
const git = (root, args, index) => execFileSync('git', ['-C', root, ...args], {
  env: index ? { ...gitEnv, GIT_INDEX_FILE: index } : gitEnv, maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const gitText = (root, args, index) => git(root, args, index).toString('utf8').trim();
function safePath(path) {
  assert(typeof path === 'string' && path.length && !isAbsolute(path) && !path.includes('\\')
    && path.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe relative path: ${path}`);
  return path;
}
function scopeCheck(root, baseline, prefix) {
  const records = git(root, ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', baseline, '--']).toString('utf8').split('\0');
  if (records.at(-1) === '') records.pop();
  assert(records.length % 2 === 0, 'Malformed Git change list');
  const added = new Set();
  for (let i = 0; i < records.length; i += 2) {
    same(records[i], 'A', 'Archive changes must only add files relative to its baseline');
    assert(records[i + 1].startsWith(prefix), `Change outside archive: ${records[i + 1]}`);
    added.add(records[i + 1]);
  }
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = status.toString('utf8').split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2), path = entries[i].slice(3);
    assert(path.startsWith(prefix), `Status outside archive: ${path}`);
    if (code !== '??') assert(added.has(path), `Status is not an archive addition: ${path}`);
    if (/[RC]/.test(code)) assert(entries[++i]?.startsWith(prefix), 'Rename/copy originates outside archive');
  }
  return { status, trackedAdditions: added.size, statusEntries: entries.length };
}

let temporary;
try {
  const options = {}, args = process.argv.slice(2);
  while (args.length) {
    const flag = args.shift();
    assert(['--repo', '--source'].includes(flag) && args.length && !args[0].startsWith('--'), `Invalid option: ${flag}`);
    options[flag.slice(2)] = resolve(args.shift());
  }
  const archiveRoot = gitText(directory, ['rev-parse', '--show-toplevel']);
  const repository = options.repo ?? archiveRoot;
  const prefix = `${relative(archiveRoot, directory).split('\\').join('/')}/`;
  same(prefix, 'proofs/performance-followup-20261118/', 'Unexpected archive location');
  const names = readdirSync(directory).filter(name => /^inventory-\d{3}\.json$/.test(name)).sort();
  assert(names.length > 0, 'No numbered inventories');
  const inventories = names.map((name, i) => {
    same(name, `inventory-${String(i + 1).padStart(3, '0')}.json`, 'Inventory sequence has a gap');
    const bytes = readFileSync(join(directory, name)), value = JSON.parse(bytes.toString('utf8'));
    same(value.schema, 'zerocopy-followup-archive/v1', 'Inventory schema');
    assert(objectId(value.baseline) && Number.isFinite(Date.parse(value.capturedAt)), 'Invalid inventory provenance');
    return { name, sha256: hash(bytes), value };
  });
  const baseline = inventories[0].value.baseline, latest = inventories.at(-1).value;
  const before = scopeCheck(archiveRoot, baseline, prefix), headBefore = gitText(archiveRoot, ['rev-parse', 'HEAD']);
  const indexName = gitText(archiveRoot, ['rev-parse', '--git-path', 'index']);
  const realIndex = isAbsolute(indexName) ? indexName : resolve(archiveRoot, indexName);
  const indexBefore = existsSync(realIndex) ? hash(readFileSync(realIndex)) : null;
  const archived = new Map(), scripts = new Set(), studies = new Map(), originalChecks = new Set();
  let entryChecks = 0, decompressions = 0;
  for (const inventory of inventories) {
    same(inventory.value.baseline, baseline, 'Archive baseline changed across inventories');
    const seen = new Set();
    for (const family of ['scripts', 'reports', 'plans', 'patches']) {
      const entries = inventory.value[family] ?? [];
      assert(Array.isArray(entries), `Invalid ${family} catalog`);
      for (const entry of entries) {
        const path = safePath(entry.path);
        assert(!seen.has(path), `Duplicate inventory path: ${path}`); seen.add(path);
        assert(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && validHash(entry.sha256), `Invalid file metadata: ${path}`);
        const target = join(directory, path);
        assert(lstatSync(target).isFile(), `Archive entry is not a regular file: ${path}`);
        const bytes = readFileSync(target);
        same(bytes.length, entry.bytes, `Archived length: ${path}`); same(hash(bytes), entry.sha256, `Archived hash: ${path}`);
        if (archived.has(path)) same(archived.get(path), { bytes: entry.bytes, sha256: entry.sha256 }, `Earlier evidence changed: ${path}`);
        else archived.set(path, { bytes: entry.bytes, sha256: entry.sha256 });
        entryChecks++;
        if (family === 'scripts') scripts.add(entry.sha256);
        let original = bytes;
        if (family === 'reports') {
          assert(bytes[0] === 0x1f && bytes[1] === 0x8b, `Report is not gzip: ${path}`);
          assert(validHash(entry.originalSha256) && Number.isSafeInteger(entry.originalBytes) && entry.originalBytes >= 0, 'Invalid original report metadata');
          original = gunzipSync(bytes); decompressions++;
          same(original.length, entry.originalBytes, `Original length: ${path}`);
          same(hash(original), entry.originalSha256, `Original hash: ${path}`);
          let report;
          try { report = JSON.parse(original.toString('utf8')); } catch { /* Empty/failed outputs remain valid archive entries. */ }
          if (report?.schema === 'zerocopy-followup-performance/v1') {
            const metadata = normal({ complete: report.complete, pairs: report.pairs, runtimes: report.runtimes,
              config: report.config, harness: report.harness, baselineCommit: report.variants?.baseline?.commit,
              candidateCommit: report.variants?.candidate?.commit, recordedSamples: report.samples?.length, error: report.error });
            same(entry.study, metadata, `Study metadata differs from raw report: ${path}`);
            studies.set(path, report);
          } else assert(!entry.study, `Non-study entry has study metadata: ${path}`);
        }
        if (options.source && family !== 'patches') {
          const sourceFile = safePath(entry.sourceFile ?? entry.originalFile ?? basename(path));
          const sourceBytes = readFileSync(join(options.source, sourceFile));
          assert(sourceBytes.equals(original), `Source original differs: ${sourceFile}`);
          originalChecks.add(`${sourceFile}:${hash(original)}`);
        }
      }
    }
  }
  const latestPaths = new Set(['scripts', 'reports', 'plans', 'patches'].flatMap(family => (latest[family] ?? []).map(entry => entry.path)));
  for (const path of archived.keys()) assert(latestPaths.has(path), `Latest inventory omits earlier evidence: ${path}`);
  for (const [path, report] of studies) for (const key of ['driverSha256', 'workloadsSha256']) {
    assert(validHash(report.harness?.[key]) && scripts.has(report.harness[key]), `Missing archived harness for ${path}: ${key}`);
  }

  temporary = mkdtempSync(join(tmpdir(), 'zerocopy-archive-index-'));
  const reconstructed = [];
  for (const [number, patch] of latest.patches.entries()) {
    assert(objectId(patch.baseline) && objectId(patch.commit), 'Invalid patch revisions');
    assert(Array.isArray(patch.expectedFiles) && patch.expectedFiles.length > 0, `Missing expected patch files: ${patch.name}`);
    const expected = patch.expectedFiles.map(entry => {
      safePath(entry.file); assert(validHash(entry.sha256), 'Invalid expected file hash'); return entry.file;
    }).sort();
    same(expected.length, new Set(expected).size, 'Duplicate expected patch file');
    if (patch.scope) same([...patch.scope].sort(), expected, `Patch scope differs: ${patch.name}`);
    const index = join(temporary, `index-${number}`);
    git(repository, ['read-tree', patch.baseline], index);
    git(repository, ['apply', '--cached', '--whitespace=nowarn', '--', join(directory, safePath(patch.path))], index);
    const changed = git(repository, ['diff', '--cached', '--no-ext-diff', '--no-renames', '--name-only', '-z', patch.baseline, '--'], index)
      .toString('utf8').split('\0').filter(Boolean).sort();
    same(changed, expected, `Changed patch paths: ${patch.name}`);
    const tree = gitText(repository, ['write-tree'], index);
    for (const entry of patch.expectedFiles) same(hash(git(repository, ['cat-file', 'blob', `${tree}:${entry.file}`], index)), entry.sha256, `Reconstructed content: ${patch.name}/${entry.file}`);
    if (patch.targetTree) { assert(objectId(patch.targetTree), 'Invalid target tree'); same(tree, patch.targetTree, `Full target tree: ${patch.name}`); }
    reconstructed.push({ name: patch.name, baseline: patch.baseline, recordedCommit: patch.commit, tree,
      changedFiles: changed.length, fullTargetTreeMatched: !!patch.targetTree });
  }
  const donor = latest.patches.find(patch => patch.name === 'ascii-byte-loads');
  const current = latest.patches.find(patch => patch.name === 'ascii-byte-loads-current');
  assert(donor && current, 'Missing donor/current-main patch pair');
  const fileHashes = patch => [...patch.expectedFiles].sort((a, b) => a.file.localeCompare(b.file));
  same(fileHashes(current), fileHashes(donor), 'Current-main transplant differs from donor');
  same([...current.scope].sort(), ['arena-string.test.ts', 'arena.ts'], 'Current-main transplant scope');
  const after = scopeCheck(archiveRoot, baseline, prefix);
  same(after.status, before.status, 'Archive Git status changed during validation');
  same(gitText(archiveRoot, ['rev-parse', 'HEAD']), headBefore, 'Archive HEAD changed');
  same(existsSync(realIndex) ? hash(readFileSync(realIndex)) : null, indexBefore, 'Real archive index changed');
  const result = { valid: true, archive: directory, repository, inventories: inventories.map(item => ({ file: item.name, sha256: item.sha256 })),
    archivedEntryChecks: entryChecks, uniqueArchivedFiles: archived.size, decompressedReportChecks: decompressions,
    uniqueStudies: studies.size, incompleteStudiesPreserved: [...studies.values()].filter(report => !report.complete).length,
    sourceOriginalsChecked: originalChecks.size, sourceDirectoryChecked: options.source ?? null,
    earlierEvidencePreserved: true, latestInventoryIncludesAllEarlierFiles: true, reconstructedPatches: reconstructed,
    exactCurrentMainTransplant: true, archiveChangesOnlyAdditions: true, trackedArchiveAdditions: after.trackedAdditions,
    statusEntries: after.statusEntries, headAndRealIndexUnchanged: true,
    scope: 'Archive bytes, original hashes, harness coverage and patch trees only. No archived code, tests, builds or benchmarks executed. Disposable indexes may add Git objects; the checkout and real index are unchanged.' };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ valid: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
