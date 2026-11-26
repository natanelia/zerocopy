import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readRawEvidence } from './raw-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('synthetic evidence archives losslessly and reproduces every saved median', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'zerocopy-evidence-archive-'));
  try {
    const source = join(temporary, 'source'), archive = join(temporary, 'archive'); mkdirSync(source);
    const schedule = [], completions = [];
    for (let pair = 0; pair < 2; pair++) for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const runtime = { name: 'synthetic' }; schedule.push({ runtime, pair, variant });
      const coldMs = (variant === 'baseline' ? 10 : 5) + pair;
      const samples = [true, false].map((warmup, processSample) => ({ type: 'sample', synthetic: true, caseId: 'fixture', fixtureSHA256: 'a'.repeat(64),
        warmup, processSample, status: 'passed', warmPasses: 16,
        measurements: { constructionMs: 1, publicationAttachmentMs: 2, coldMs, constructionToFirstLocalAnswerMs: 3 + coldMs, warmBatchMs: 32, warmPassMs: 2 },
        memory: { retainedAfterReads: { heapUsed: variant === 'baseline' ? 20000 : 18000 } },
      }));
      const lines = [{ type: 'process-start', synthetic: true, pair, variant }, ...samples, { type: 'process-end', status: 'passed' }];
      const bytes = Buffer.from(lines.map(line => JSON.stringify(line)).join('\n') + '\n'), file = `pair-${pair}-${variant}.jsonl`, stderr = file + '.stderr';
      writeFileSync(join(source, file), bytes); writeFileSync(join(source, stderr), '');
      completions.push({ runtime, pair, variant, code: 0, file, stderr, sha256: sha256(bytes) });
    }
    const manifest = { schema: 'zerocopy-standard-get-study/v1', synthetic: true, pairs: 2, warmups: 1, cases: ['fixture'], schedule,
      identities: { baseline: { commit: '1'.repeat(40), libraryHashes: { 'shared.js': 'b'.repeat(64) } }, candidate: { commit: '2'.repeat(40) }, harness: { commit: '3'.repeat(40) } } };
    writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(source, 'completions.json'), JSON.stringify(completions, null, 2));
    writeFileSync(join(source, 'study-complete.json'), JSON.stringify({ planned: 4, completed: 4, failed: 0 }));
    execFileSync(process.execPath, [join(here, 'summarize.mjs'), source]);
    const originals = Object.fromEntries(readdirSync(source).map(name => [name, readFileSync(join(source, name))]));

    execFileSync(process.execPath, [join(here, 'archive.mjs'), source, archive]);
    for (const [name, bytes] of Object.entries(originals)) assert.deepEqual(readFileSync(join(source, name)), bytes, `original ${name} unchanged`);
    for (const name of ['manifest.json', 'completions.json', 'summary.json', 'study-complete.json']) assert.deepEqual(readFileSync(join(archive, name)), originals[name], `${name} retained byte-for-byte`);
    for (const completion of completions) {
      assert.equal(existsSync(join(archive, completion.file)), false);
      const raw = readRawEvidence(archive, completion.file);
      assert.equal(raw.compressed, true); assert.deepEqual(raw.bytes, originals[completion.file]);
      assert.equal(sha256(raw.bytes), completion.sha256);
      assert.deepEqual(readRawEvidence(archive, completion.file + '.gz').bytes, originals[completion.file]);
    }
    const verification = JSON.parse(execFileSync(process.execPath, [join(here, 'summarize.mjs'), archive, '--verify-only'], { encoding: 'utf8' }));
    assert.equal(verification.storedSummaryCompared, true); assert.equal(verification.incompleteRows, 0);
    assert.deepEqual(readFileSync(join(archive, 'summary.json')), originals['summary.json']);
    assert.notEqual(spawnSync(process.execPath, [join(here, 'archive.mjs'), source, archive]).status, 0, 'existing archive cannot be overwritten');
    assert.notEqual(spawnSync(process.execPath, [join(here, 'summarize.mjs'), archive]).status, 0, 'saved summary cannot be overwritten');

    const victim = completions[0], corrupted = Buffer.from(originals[victim.file].toString().replace('"coldMs":10', '"coldMs":99'));
    assert.notDeepEqual(corrupted, originals[victim.file]);
    writeFileSync(join(archive, victim.file + '.gz'), gzipSync(corrupted));
    const rejected = spawnSync(process.execPath, [join(here, 'summarize.mjs'), archive, '--verify-only'], { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Changed raw file/);
    assert.deepEqual(readFileSync(join(source, victim.file)), originals[victim.file]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
