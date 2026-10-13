/** Import a complete new recording without rewriting any historical evidence. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.argv[2], 'Pass the committed raw summary path');
assert.ok(process.argv[3] === undefined || process.argv[3] === '--eight-readers', 'Unknown cohort option');
const eight = process.argv[3] === '--eight-readers', expectedRuns = eight ? 12 : 36;
// This option imports the preserved, runtime-matched supplement. Ordinary new
// eight-reader recordings remain standalone until a new chart cohort is reviewed.
const path = resolve(root, process.argv[2]), sourceSummary = relative(root, path);
assert.match(sourceSummary, /^proofs\/results\/feature-map-memory\/[A-Za-z0-9_-]+\/summary\.json$/);
const source = readFileSync(path), data = JSON.parse(source);
assert.equal(data.status, 'verified'); assert.equal(data.recordingType, eight ? 'eight-reader-cohort' : 'full-matrix'); assert.equal(data.chartEligible, true);
assert.equal(data.entries, 100000); assert.equal(data.trials, 3); assert.equal(data.runCount, expectedRuns);
const sourceTerminal = sourceSummary.replace('summary.json', 'controller/terminal.json');
const terminalSource = readFileSync(resolve(root, sourceTerminal)), terminal = JSON.parse(terminalSource);
assert.equal(terminal.status, 'verified'); assert.equal(terminal.chartEligible, true); assert.equal(terminal.verifiedRuns, expectedRuns);
assert.equal(terminal.cleanup.empty, true); assert.deepEqual(terminal.cleanup.final, []); assert.equal(terminal.trigger, null);
const record = { ...data, sourceSummary, summarySHA256: createHash('sha256').update(source).digest('hex'), sourceTerminal, terminalSHA256: createHash('sha256').update(terminalSource).digest('hex') };
writeFileSync(resolve(root, eight ? 'website/feature-memory-eight-data.json' : 'website/feature-memory-data.json'), JSON.stringify(record, null, 2) + '\n');
const { validateFeatureMemory, validateEightReaderMemory, featureMemorySVG } = await import('../website/feature-memory-charts.mjs');
(eight ? validateEightReaderMemory : validateFeatureMemory)(record);
const chart = eight ? 'rss-eight' : 'rss';
writeFileSync(resolve(root, `docs/assets/feature-memory-${chart}.svg`), featureMemorySVG(chart));
console.log(`Imported ${expectedRuns} source-verified feature-map cases from ${sourceSummary}; cohort provenance preserved`);
