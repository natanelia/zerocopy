const DISPLAY_RESOLUTION_MS = 0.01;
const unavailable = '—';

function validMilliseconds(value) {
  return Number.isFinite(value) && value >= 0;
}

export function formatMilliseconds(value) {
  if (!validMilliseconds(value)) return unavailable;
  if (value < DISPLAY_RESOLUTION_MS) return '<0.01 ms';
  return `${value.toLocaleString('en-US', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 })} ms`;
}

/** Describes only this observation; below-resolution readings cannot support a ratio. */
export function compareElapsed(candidate, native) {
  if (!validMilliseconds(candidate) || !validMilliseconds(native)
      || candidate < DISPLAY_RESOLUTION_MS || native < DISPLAY_RESOLUTION_MS) return unavailable;
  if (formatMilliseconds(candidate) === formatMilliseconds(native)) {
    return 'Same at displayed precision vs native · this run';
  }

  const percent = Math.abs((candidate - native) / native) * 100;
  if (!Number.isFinite(percent)) return unavailable;
  const rounded = Number(percent.toFixed(1));
  // Do not turn a small difference into 0%, or a nonzero duration into 100% less time.
  const amount = rounded === 0 ? '<0.1' : candidate < native && rounded === 100 ? '>99.9' : String(rounded);
  return `${amount}% ${candidate < native ? 'less' : 'more'} time vs native · this run`;
}
