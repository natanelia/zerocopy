/** Deterministic sample data and bounded operations. No library or DOM dependency. */
export const SERVICES = ['gateway', 'accounts', 'payments', 'notifications'];
export const LEVELS = ['info', 'warn', 'error'];
export const FIELDS = ['time', 'service', 'level', 'latency', 'message'];
export const START_TIME = Date.UTC(2025, 0, 1, 12);
export const STEP_MS = 12;
export const MAX_EVENTS = 200_000;
export const BATCH_SIZE = 2_000;
export const PAGE_SIZE = 50;
export const BUCKETS = 60;
export const CHANNEL = 'zerocopy-log-explorer';
export const RPC = 'zerocopy/log-demo/v1';

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
export function validateSize(size) { return integer(size, 1_000, 100_000, 'Initial event count'); }
export function hash(index) {
  let value = (index + 1) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}
/** A repeated, visible payment timeout spike; generated examples, never production logs. */
export function sampleEvent(index) {
  integer(index, 0, MAX_EVENTS - 1, 'Event index');
  const n = hash(index), phase = index % 100_000;
  const spike = phase >= 55_000 && phase < 65_000;
  const service = spike ? 2 : n % SERVICES.length;
  const level = spike ? (n % 10 < 7 ? 2 : 1) : (n % 100 < 3 ? 2 : n % 100 < 12 ? 1 : 0);
  const message = level === 2 ? (service === 2 ? 'Upstream timeout while authorizing payment' : 'Request failed: upstream timeout')
    : level === 1 ? 'Retry scheduled after a slow response' : ['Request completed', 'Cache hit', 'Connection opened', 'Background job completed'][(n >>> 8) % 4];
  return { time: START_TIME + index * STEP_MS, service, level, latency: level === 2 ? 1800 + n % 3200 : 8 + n % 240, message };
}
export function emptyColumns() { return Object.fromEntries(FIELDS.map(field => [field, []])); }
export function generateColumns(start, count) {
  integer(start, 0, MAX_EVENTS, 'Start'); integer(count, 0, MAX_EVENTS - start, 'Count');
  const columns = emptyColumns();
  for (let index = start; index < start + count; index++) {
    const event = sampleEvent(index);
    for (const field of FIELDS) columns[field].push(event[field]);
  }
  return columns;
}
export function validateColumns(columns) {
  if (!columns || !FIELDS.every(field => Array.isArray(columns[field]))) throw new TypeError('Expected five native columns');
  const length = columns.time.length;
  integer(length, 0, MAX_EVENTS, 'Column length');
  if (!FIELDS.every(field => columns[field].length === length)) throw new Error('Column lengths do not match');
  return columns;
}
export function appendNative(columns, delta) {
  validateColumns(columns); validateColumns(delta);
  if (columns.time.length + delta.time.length > MAX_EVENTS) throw new RangeError('Event capacity reached');
  for (const field of FIELDS) for (const value of delta[field]) columns[field].push(value);
}
export function nativeView(columns) {
  validateColumns(columns);
  return { length: columns.time.length, get: (field, index) => columns[field][index] };
}
export function sharedView(columns) {
  if (!columns || !FIELDS.every(field => typeof columns[field]?.get === 'function')) throw new TypeError('Expected shared columns');
  const length = columns.time.size;
  integer(length, 0, MAX_EVENTS, 'Column length');
  if (!FIELDS.every(field => columns[field].size === length)) throw new Error('Shared column lengths do not match');
  return { length, get: (field, index) => columns[field].get(index) };
}
export function normalizeQuery(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('Expected a query');
  const term = input.term ?? '', service = input.service ?? -1, level = input.level ?? -1;
  if (typeof term !== 'string' || term.length > 128) throw new RangeError('Search text must contain at most 128 characters');
  integer(service, -1, SERVICES.length - 1, 'Service'); integer(level, -1, LEVELS.length - 1, 'Level');
  const offset = integer(input.offset ?? 0, 0, MAX_EVENTS, 'Page offset');
  const limit = integer(input.limit ?? PAGE_SIZE, 1, 100, 'Page size');
  const from = input.from ?? null, to = input.to ?? null;
  if ((from !== null && !Number.isFinite(from)) || (to !== null && !Number.isFinite(to)) || (from !== null && to !== null && from > to)) throw new RangeError('Invalid time range');
  return { term: term.trim().toLowerCase(), service, level, offset, limit, from, to };
}
export function matches(view, index, query) {
  if (query.service !== -1 && view.get('service', index) !== query.service) return false;
  if (query.level !== -1 && view.get('level', index) !== query.level) return false;
  const time = view.get('time', index);
  if (query.from !== null && time < query.from) return false;
  if (query.to !== null && time >= query.to) return false;
  return !query.term || view.get('message', index).toLowerCase().includes(query.term);
}
export function rowAt(view, index) {
  integer(index, 0, view.length - 1, 'Selected row');
  return { index, ...Object.fromEntries(FIELDS.map(field => [field, view.get(field, index)])) };
}
// A posted message yields to the task queue without nested-timer clamping.
// All implementations use this same scheduler and the same checkpoints.
let yieldChannel, yieldWaiters = [];
export function yieldToEvents() {
  if (typeof MessageChannel === 'undefined') return new Promise(resolve => setTimeout(resolve, 0));
  if (!yieldChannel) {
    yieldChannel = new MessageChannel();
    yieldChannel.port1.onmessage = () => {
      const waiters = yieldWaiters;
      yieldWaiters = [];
      yieldChannel.port1.unref?.(); // Idle Node tests must be able to exit.
      for (const resolve of waiters) resolve();
    };
    yieldChannel.port1.unref?.();
    yieldChannel.port2.unref?.();
  }
  return new Promise(resolve => {
    yieldWaiters.push(resolve);
    if (yieldWaiters.length === 1) {
      yieldChannel.port1.ref?.();
      yieldChannel.port2.postMessage(null);
    }
  });
}
/** Periodic task-queue yields allow cancellation. A Promise-only yield would not. */
async function checkpoint(index, cancelled) {
  if ((index & 4095) !== 0) return;
  if (cancelled()) throw new Error('Calculation cancelled');
  await yieldToEvents();
  if (cancelled()) throw new Error('Calculation cancelled');
}
export async function search(view, input, cancelled = () => false) {
  const query = normalizeQuery(input), indices = [];
  let total = 0, checksum = 0;
  for (let index = view.length - 1; index >= 0; index--) {
    if ((index & 4095) === 0) await checkpoint(index, cancelled);
    if (!matches(view, index, query)) continue;
    checksum = (checksum + index) >>> 0;
    if (total >= query.offset && indices.length < query.limit) indices.push(index);
    total++;
  }
  return { total, indices, checksum };
}
export async function summarizeEvents(view, input, cancelled = () => false) {
  const query = normalizeQuery(input);
  const begin = view.length ? view.get('time', 0) : START_TIME;
  const end = view.length ? view.get('time', view.length - 1) + STEP_MS : begin + 1;
  const counts = Array(BUCKETS).fill(0), errors = Array(BUCKETS).fill(0), services = Array(SERVICES.length).fill(0);
  let total = 0, errorCount = 0, latencySum = 0, checksum = 0;
  for (let index = 0; index < view.length; index++) {
    if ((index & 4095) === 0) await checkpoint(index, cancelled);
    if (!matches(view, index, query)) continue;
    const bucket = Math.min(BUCKETS - 1, Math.floor((view.get('time', index) - begin) / (end - begin) * BUCKETS));
    counts[bucket]++; services[view.get('service', index)]++;
    const isError = view.get('level', index) === 2;
    if (isError) { errors[bucket]++; errorCount++; }
    total++; checksum = (checksum + index) >>> 0; latencySum += view.get('latency', index);
  }
  return { total, checksum, counts, errors, services, errorCount, latencySum, begin, end };
}
export function assertSameAnswer(searchResult, summary) {
  if (searchResult.total !== summary.total || searchResult.checksum !== summary.checksum) throw new Error('The readers did not agree on the snapshot');
}
