import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureName = 'fixtures/numeric-pr71.ts.txt';
const fixture = readFileSync(join(here, fixtureName));
const fixtureSha = 'b22d734d47523ca408605971c991b87aa499b6e9f3ec0c0c4ede7d6625cb786d';
assert.equal(sha(fixture), fixtureSha, 'The integration fixture must remain the reviewed PR #71 numeric source');
const temporary = mkdtempSync(join(tmpdir(), 'zerocopy-map-early-identity-'));
try {
  const packageRoot = join(temporary, 'node_modules', 'zerocopy');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const files = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && (entry.name === 'package.json' || entry.name.endsWith('.wasm')
      || entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.as.ts')))
    .map(entry => entry.name).sort();
  const source = {};
  for (const name of files) {
    copyFileSync(join(root, name), join(packageRoot, name));
    source[name] = sha(readFileSync(join(root, name)));
  }
  // The sole overlay models #71 without fetching another branch or PR.
  writeFileSync(join(packageRoot, 'numeric.ts'), fixture);
  const subject = readFileSync(join(here, 'integration-subject.mjs'));
  writeFileSync(join(temporary, 'subject.mjs'), subject);
  const stdout = execFileSync(process.env.BUN_BINARY || 'bun', ['subject.mjs'], {
    cwd: temporary, encoding: 'utf8', timeout: 60000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'passed');
  assert.equal(result.source['numeric.ts'], fixtureSha);
  for (const name of ['arena.ts', 'shared-map.ts', 'package.json']) assert.equal(result.source[name], source[name]);
  console.log(JSON.stringify({
    schema: 'zerocopy-map-early-identity-integration/v1', status: 'passed',
    source, overlay: { path: 'numeric.ts', fixture: fixtureName, sha256: fixtureSha },
    runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    subjectSha256: sha(subject), result, timingMeasurements: false,
  }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
