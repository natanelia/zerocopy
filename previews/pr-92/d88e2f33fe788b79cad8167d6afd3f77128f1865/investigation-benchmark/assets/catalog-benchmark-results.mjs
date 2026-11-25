/** Shared, fixed-count statistics for the browser report and offline evidence checks. */
export const WARMUPS = 2;
export const SAMPLES = 7;
export const READ_PHASES = [
  'startupMs', 'constructionMs', 'publicationMs', 'firstQueryMs', 'repeatQueryMs',
  'firstRoundTripMs', 'repeatRoundTripMs', 'constructionToFirstAnswerMs',
  'updateMs', 'editPublicationMs', 'updatedQueryMs', 'retainedQueryMs',
];

export function summarize(values, expected = SAMPLES) {
  if (values.length !== expected || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('Incomplete or invalid benchmark samples for a measured phase');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = fraction => {
    const position = (sorted.length - 1) * fraction, low = Math.floor(position), high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  };
  return { median: quantile(.5), min: sorted[0], max: sorted.at(-1), p25: quantile(.25), p75: quantile(.75) };
}

export function summarizeCases(raw, cases, phasesForCase, samples = SAMPLES) {
  const expectedIds = new Set(cases.map(item => item.id));
  if (expectedIds.size !== cases.length || raw.some(record => !expectedIds.has(record.caseId))) {
    throw new Error('Benchmark cases do not match the declared workload');
  }
  const rounds = new Set(), sequences = new Set();
  for (const record of raw) {
    if (!Number.isInteger(record.round) || record.round < 1 || record.round > WARMUPS + samples ||
        record.warmup !== (record.round <= WARMUPS) ||
        !Number.isInteger(record.sequence) || record.sequence < 1 ||
        (record.status !== undefined && record.status !== 'passed')) {
      throw new Error('Invalid or failed benchmark sample cannot be summarized');
    }
    const id = `${record.caseId}:${record.round}`;
    if (rounds.has(id) || sequences.has(record.sequence)) throw new Error('Duplicate benchmark sample');
    rounds.add(id); sequences.add(record.sequence);
  }
  if (raw.length !== cases.length * (WARMUPS + samples)) throw new Error('Incomplete benchmark rounds');
  const measured = raw.filter(record => !record.warmup);
  return Object.fromEntries(cases.map(item => {
    const records = measured.filter(record => record.caseId === item.id);
    return [item.id, Object.fromEntries(phasesForCase(item).map(phase => [phase, summarize(records.map(record => record[phase]), samples)]))];
  }));
}
