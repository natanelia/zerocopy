import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readRawEvidence } from './raw-evidence.mjs';
const directory = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Pass the recorded study directory');
const options = process.argv.slice(3);
let verifyOnly = false, requestedOutput;
for (let i = 0; i < options.length; i++) {
  if (options[i] === '--verify-only') verifyOnly = true;
  else if (options[i] === '--out') {
    requestedOutput = options[++i];
    if (!requestedOutput || requestedOutput.startsWith('--')) throw new Error('--out needs a new filename');
  } else throw new Error('Use --verify-only or --out NEW_FILE');
}
if (verifyOnly && requestedOutput) throw new Error('Choose verification or a new summary output');
const output = requestedOutput ? resolve(requestedOutput) : resolve(directory, 'summary.json');
const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'))), completions = JSON.parse(readFileSync(resolve(directory, 'completions.json')));
const median = values => { const sorted = [...values].sort((a, b) => a - b), n = sorted.length; return !n ? null : n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2; };
const grouped = new Map(), failures = [], seenProcesses = new Set();
const runtimeNames = [...new Set(manifest.schedule.map(item => item.runtime.name))];
for (const runtime of runtimeNames) for (const caseId of manifest.cases) grouped.set(`${runtime}:${caseId}`, []);
function metrics(record) {
  const output = { ...record.measurements };
  for (const [stage, memory] of Object.entries(record.memory ?? {})) {
    if (memory && typeof memory === 'object') for (const [key, value] of Object.entries(memory)) if (typeof value === 'number' && Number.isFinite(value)) output[`memory.${stage}.${key}`] = value;
  }
  for (const stage of ['arenaBefore', 'arenaAfter']) if (record[stage]) {
    for (const key of ['usedBytes', 'capacityBytes']) output[`${stage}.${key}`] = record[stage].reduce((sum, arena) => sum + arena[key], 0);
  }
  return output;
}
for (const completion of completions) {
  const processKey = `${completion.runtime.name}:${completion.pair}:${completion.variant}`;
  if (seenProcesses.has(processKey)) throw new Error('Duplicate process completion');
  seenProcesses.add(processKey);
  if (!runtimeNames.includes(completion.runtime.name) || !['baseline', 'candidate'].includes(completion.variant)
      || !Number.isInteger(completion.pair) || completion.pair < 0 || completion.pair >= manifest.pairs) throw new Error('Process is outside predetermined schedule');
  const { bytes } = readRawEvidence(directory, completion.file);
  if (createHash('sha256').update(bytes).digest('hex') !== completion.sha256) throw new Error(`Changed raw file ${completion.file}`);
  const lines = bytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (completion.code !== 0 || lines.at(-1)?.status !== 'passed') failures.push({ completion, failures: lines.filter(line => line.status === 'failed' || line.type === 'process-failure') });
  const seenCases = new Set();
  const sampleRecords = lines.filter(line => line.type === 'sample');
  if (completion.code === 0) {
    for (const caseId of manifest.cases) {
      const samples = sampleRecords.filter(record => record.caseId === caseId);
      if (samples.length !== manifest.warmups + 1 || samples.some((record, i) => record.processSample !== i || record.warmup !== (i < manifest.warmups))) {
        throw new Error(`Missing or reordered warmup/measured records for ${caseId}`);
      }
    }
  }
  for (const record of lines.filter(line => line.type === 'sample' && !line.warmup && line.status === 'passed')) {
    if (seenCases.has(record.caseId) || !manifest.cases.includes(record.caseId)) throw new Error('Duplicate or unexpected measured case');
    seenCases.add(record.caseId);
    if (!/^[a-f0-9]{64}$/.test(record.fixtureSHA256)) throw new Error('Missing fixture identity');
    const m = record.measurements;
    if (m.constructionToFirstLocalAnswerMs !== undefined && m.constructionToFirstLocalAnswerMs !== m.constructionMs + m.publicationAttachmentMs + m.coldMs) throw new Error('Incorrect per-sample local total');
    if (m.constructionToFirstAnswerMs !== undefined && m.constructionToFirstAnswerMs !== m.constructionMs + m.publicationMs + (m.firstRoundTripMs ?? m.firstQueryMs)) throw new Error('Incorrect per-sample website total');
    if (m.warmPassMs !== undefined && m.warmPassMs !== m.warmBatchMs / record.warmPasses) throw new Error('Incorrect warm batch average');
    const key = `${completion.runtime.name}:${record.caseId}`;
    const group = grouped.get(key) ?? [];
    group.push({ ...completion, record }); grouped.set(key, group);
  }
}
const rows = [];
for (const [key, group] of grouped) {
  const [runtime, caseId] = key.split(':');
  if (!group.length) { rows.push({ runtime, caseId, complete: false, note: 'MISSING: no successful measured case' }); continue; }
  for (const metric of Object.keys(metrics(group[0].record))) {
    const pairs = [];
    for (let pair = 0; pair < manifest.pairs; pair++) {
      const a = group.filter(item => item.pair === pair && item.variant === 'baseline'), b = group.filter(item => item.pair === pair && item.variant === 'candidate');
      if (a.length !== 1 || b.length !== 1) continue;
      if (a[0].record.fixtureSHA256 !== b[0].record.fixtureSHA256) throw new Error(`Fixture changed for ${key}`);
      const before = metrics(a[0].record)[metric], after = metrics(b[0].record)[metric];
      if (!Number.isFinite(before) || !Number.isFinite(after) || before < 0 || after < 0) throw new Error('Invalid raw measurement');
      pairs.push({ pair, before, after, ratio: before > 0 ? after / before : null });
    }
    const complete = pairs.length === manifest.pairs;
    rows.push({ runtime, caseId, metric, complete, pairs, beforeMedian: median(pairs.map(pair => pair.before)), afterMedian: median(pairs.map(pair => pair.after)),
      pairedRatioMedian: pairs.every(pair => pair.ratio !== null) ? median(pairs.map(pair => pair.ratio)) : null,
      lowerPairs: pairs.filter(pair => pair.after < pair.before).length,
      ...(metric.endsWith('Ms') ? { fasterPairs: pairs.filter(pair => pair.after < pair.before).length, unit: 'ms' } : { unit: metric.endsWith('KiB') ? 'KiB' : 'bytes' }),
      note: complete ? 'Descriptive paired estimates; not an automatic significance or regression gate.' : 'INCOMPLETE: do not present as a successful fixed-count study.' });
  }
}
const result = { schema: 'zerocopy-standard-get-summary/v1', failures, rows, plannedProcesses: manifest.schedule.length, completedProcesses: completions.length,
  complete: completions.length === manifest.schedule.length && !failures.length && rows.every(row => row.complete), createdAt: new Date().toISOString() };
let storedSummaryCompared = false;
if (verifyOnly) {
  if (existsSync(output)) {
    const saved = JSON.parse(readFileSync(output));
    for (const key of ['schema', 'failures', 'rows', 'plannedProcesses', 'completedProcesses', 'complete']) {
      if (JSON.stringify(saved[key]) !== JSON.stringify(result[key])) throw new Error(`Saved summary does not reproduce from raw evidence: ${key}`);
    }
    storedSummaryCompared = true;
  }
} else writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' });
process.stdout.write(JSON.stringify({ rows: rows.length, failedProcesses: failures.length, incompleteRows: rows.filter(row => !row.complete).length,
  verifyOnly, storedSummaryCompared }, null, 2) + '\n');
