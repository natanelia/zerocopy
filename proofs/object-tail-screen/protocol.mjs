import assert from 'node:assert/strict';
import { CASES as ORIGINAL_CASES, SETTINGS, chooseWork, interval, median, mean, sameWork } from './cached-object-read-protocol.mjs';
export { SETTINGS };
export const PINS = Object.freeze({
  baseline: '3773c6e519c7c0958da13727ed1082f449f3ee25',
  original: '042b41a7f68a89a10751f285eef79259adfe4aa3',
  refinement: '25b55f5dfacb926dc3d7354234c6d69326329071',
});
export const CASES = Object.freeze(['map-object-512', 'map-number-512', 'map-string-512'].map(id => ORIGINAL_CASES.find(c => c.id === id)));
export const GROUPS = Object.freeze({
  'baseline-refinement': ['baseline', 'refinement'],
  'original-refinement': ['original', 'refinement'],
  'baseline-aa': ['baseline', 'baseline'],
  'original-aa': ['original', 'original'],
  'refinement-aa': ['refinement', 'refinement'],
});
export const SEED = 0x6b3a912d;
export const LIMITS = Object.freeze({ campaignMs: 30 * 60 * 1000, processMs: 120000, measuredSubjects: 240, pilots: 9 });
function random(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
function shuffled(items, next) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
export function campaign() {
  const next = random(SEED), result = [], orientations = new Map();
  for (const spec of CASES) for (const group of Object.keys(GROUPS)) {
    orientations.set(spec.id + '/' + group, shuffled(['ABBA', 'ABBA', 'BAAB', 'BAAB'], next));
  }
  for (let quartet = 0; quartet < SETTINGS.quartets; quartet++) {
    for (const spec of shuffled(CASES, next)) for (const group of shuffled(Object.keys(GROUPS), next)) {
      const labels = orientations.get(spec.id + '/' + group)[quartet];
      for (let position = 0; position < 4; position++) {
        const label = labels[position];
        result.push({ runtime: 'bun', workload: spec.id, group, quartet, position, label, role: GROUPS[group][label === 'A' ? 0 : 1] });
      }
    }
  }
  assert.equal(result.length, LIMITS.measuredSubjects);
  return result;
}
export function chooseThree(pilots) {
  assert.equal(pilots.length, 3);
  const a = chooseWork(pilots.slice(0, 2)), b = chooseWork(pilots.slice(1, 3));
  return { sweeps: Math.max(a.sweeps, b.sweeps), warmSweeps: Math.max(a.warmSweeps, b.warmSweeps) };
}
export function summarizeGroup(records, workload, group) {
  const expected = campaign().filter(x => x.workload === workload && x.group === group);
  assert.equal(records.length, 16, 'all four quartets required');
  records.forEach((r, i) => {
    for (const key of Object.keys(expected[i])) assert.equal(r[key], expected[i][key], 'complete immutable schedule');
    sameWork(records[0].result, r.result);
  });
  const logs = [];
  for (let q = 0; q < SETTINGS.quartets; q++) {
    const quartet = records.filter(r => r.quartet === q);
    const values = label => quartet.filter(r => r.label === label).map(r => Math.log(median(r.result.samples.map(s => s.ms))));
    logs.push(mean(values('B')) - mean(values('A')));
  }
  return interval(logs);
}
export const aaDrift = x => (x.ratio < 1 / SETTINGS.margin || x.ratio > SETTINGS.margin) && (x.lower > 1 || x.upper < 1);
export const aaEquivalent = x => x.lower >= 1 / SETTINGS.margin && x.upper <= SETTINGS.margin;
export function summarize(records, outcomes) {
  assert.equal(outcomes.length, LIMITS.measuredSubjects, 'each scheduled subject requires an outcome');
  assert.deepEqual(outcomes.map(({ valid, reason, ...x }) => x), campaign().map((x, ordinal) => ({ ...x, ordinal })));
  const cells = CASES.map(spec => {
    const groups = {};
    for (const group of Object.keys(GROUPS)) {
      const subset = records.filter(r => r.workload === spec.id && r.group === group);
      groups[group] = subset.length === 16 ? summarizeGroup(subset, spec.id, group) : { invalid: true, validSubjects: subset.length };
    }
    const comparisons = {};
    for (const original of ['baseline', 'original']) {
      const ab = groups[original + '-refinement'], aa = [groups[original + '-aa'], groups['refinement-aa']];
      const invalid = [ab, ...aa].some(x => x.invalid);
      comparisons[original] = invalid ? { invalid: true } : {
        ab, aaDrift: aa.some(aaDrift), aaEquivalent: aa.every(aaEquivalent),
        withinMargin: ab.upper <= SETTINGS.margin, adverse: ab.lower > SETTINGS.margin,
        substantial: ab.upper <= SETTINGS.substantialUpper, improved: ab.upper < 1,
        label: aa.some(aaDrift) ? 'aa-drift-invalidated' : ab.lower > SETTINGS.margin ? 'adverse' : ab.upper <= SETTINGS.margin ? 'within-margin' : 'inconclusive',
      };
    }
    return { workload: spec.id, groups, comparisons };
  });
  const valid = outcomes.every(x => x.valid);
  const drift = cells.some(c => Object.entries(c.groups).some(([name, x]) => name.endsWith('-aa') && !x.invalid && aaDrift(x)));
  const object = cells[0].comparisons;
  const concernsCleared = valid && !drift && object.baseline.substantial && object.original.withinMargin
    && cells.slice(1).every(c => c.comparisons.baseline.withinMargin);
  return { cells, complete: valid, totalScheduled: 240, validSubjects: records.length,
    objectGainPreserved: valid && !drift && object.baseline.substantial && object.original.withinMargin,
    primitiveConcernsCleared: valid && !drift && cells.slice(1).every(c => c.comparisons.baseline.withinMargin),
    focusedDiagnosticClear: concernsCleared, globalClearance: false,
    limitation: 'Pointwise intervals from four quartet contrasts. Shared refinement AA is dependent evidence for both comparisons. No pooling with historical campaigns or global clearance.' };
}
