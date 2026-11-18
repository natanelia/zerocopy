// Fixed selective-JSON string-scan workloads. No whole-record .get() claim.
const check = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (a, b, label) => check(Object.is(a, b), `${label}: unequal values`);
const collect = () => typeof globalThis.gc === 'function' ? globalThis.gc() : globalThis.Bun?.gc?.(true);
const encoder = new TextEncoder();
export const cases = [
  ...[0, 4, 8, 16, 64, 256, 4096].flatMap(bytes => ['string', 'after'].map(operation =>
    ({ name: `json-string.${operation}.ascii.${bytes}`, group: 'json-string', operation, style: 'ascii', bytes }))),
  ...['unicode', 'escaped'].flatMap(style => [256, 4096].flatMap(bytes => ['string', 'after'].map(operation =>
    ({ name: `json-string.${operation}.${style}.${bytes}`, group: 'json-string', operation, style, bytes })))),
  { name: 'json-string.first-number.key2', group: 'json-string', operation: 'first', field: 'id', bytes: 0 },
  { name: 'json-string.first-number.key8', group: 'json-string', operation: 'first', field: 'counting', bytes: 0 },
  { name: 'json-string.missing.small', group: 'json-string', operation: 'missing', bytes: 0 },
];

function textValue(style, bytes) {
  if (style === 'ascii') return 'x'.repeat(bytes);
  const token = style === 'unicode' ? '道路🙂' : 'x"\\\n';
  const tokenBytes = encoder.encode(JSON.stringify(token)).length - 2;
  const value = token.repeat(Math.floor(bytes / tokenBytes)) + 'x'.repeat(bytes % tokenBytes);
  equal(encoder.encode(JSON.stringify(value)).length - 2, bytes, 'Fixture JSON payload byte length');
  return value;
}
function state(lib, data) {
  const payload = lib.getWorkerData({ data }, { copy: false });
  check(payload.arenas.length === 1, 'Expected one shared arena');
  const arena = payload.arenas[0];
  check(arena.memory instanceof WebAssembly.Memory && !arena.copy, 'Expected shared-memory attachment');
  return { used: arena.used, capacity: arena.memory.buffer.byteLength, memory: arena.memory };
}
function readBatch(view, field, output, offset, count) {
  for (let i = 0; i < count; i++) output[offset + i] = view.get(field);
}
function verifyValues(output, expected) {
  let checksum = 0;
  for (const value of output) {
    equal(value, expected, 'Selected scalar');
    checksum += typeof value === 'string' ? value.length : value === undefined ? -1 : value;
  }
  return checksum;
}
async function measure(lib, item, config) {
  const text = item.style ? textValue(item.style, item.bytes) : '';
  const document = item.operation === 'first' ? { [item.field]: 17, code: 'A4', active: true, count: 23 }
    : item.operation === 'missing' ? { id: 17, code: 'A4', active: true, count: 23 }
    : { text, target: 29, sibling: { value: 313 } };
  const field = item.operation === 'string' ? 'text' : item.operation === 'after' ? 'target' : item.operation === 'missing' ? 'missing' : item.field;
  const expected = document[field];
  lib.resetMap();
  const writer = new lib.SharedMap('object').set('doc', document);
  const updated = writer.set('doc', { ...document, target: 99, text: 'changed' });
  const reader = await lib.initWorker(lib.getWorkerData({ data: writer, updated }, { copy: false }));
  const makeView = () => reader.data.getView('doc');
  const targetCalls = item.bytes <= 16 ? 1048576 : item.bytes <= 256 ? 262144 : item.operation === 'string' ? 16384 : 65536;
  const iterations = 64, callsPerView = Math.max(1, Math.ceil(targetCalls * (config.batchScale ?? 1) / iterations));
  const operations = iterations * callsPerView, warmOutput = new Array(callsPerView);
  for (let i = 0; i < config.warmups; i++) {
    readBatch(makeView(), field, warmOutput, 0, callsPerView); verifyValues(warmOutput, expected);
  }
  // Each iteration receives a fresh prepared view. Repeated field selection has
  // no JsonView value cache; results are retained so decoding cannot disappear.
  const views = Array.from({ length: iterations }, makeView), outputs = new Array(operations);
  const before = state(lib, reader.data), image = new Uint8Array(before.memory.buffer, 0, before.used).slice();
  collect();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) readBatch(views[i], field, outputs, i * callsPerView, callsPerView);
  const elapsedMs = performance.now() - start;
  const checksum = verifyValues(outputs, expected);
  equal(JSON.stringify(makeView().toObject()), JSON.stringify(document), 'Retained record');
  equal(reader.updated.getView('doc').get('target'), 99, 'Updated record');
  const after = state(lib, reader.data);
  equal(after.used, before.used, 'Reader allocated shared bytes');
  equal(after.capacity, before.capacity, 'Reader grew memory');
  const bytes = new Uint8Array(after.memory.buffer, 0, before.used);
  for (let i = 0; i < image.length; i++) if (bytes[i] !== image[i]) throw new Error(`Reader changed shared byte ${i}`);
  return { elapsedMs, operations, millisecondsPer10000: elapsedMs / operations * 10000,
    count: 1, iterations, callsPerView, checksum, ordinaryGet: false, operation: 'JsonView.get',
    field, style: item.style ?? 'small-object-control', serializedStringPayloadBytes: item.bytes,
    decodedStringCodeUnits: text.length, freshViewPerIteration: true,
    repeatedSelectionOfOneRecord: true, preparedReadOnlyAttachment: true,
    maximumRetainedStringPayloadBytes: item.operation === 'string' ? operations * text.length * 2 : 0,
    sharedBytesUnchanged: true, sharedArenaAllocationBytes: 0, sharedUsedBytes: before.used };
}

export async function run(lib, config, rotation = 0) {
  check(Number.isSafeInteger(config.warmups) && config.warmups >= 0 && config.warmups <= 64, 'Invalid warmups');
  const selected = cases.filter(item => (!config.group || config.group === item.group) && (!config.only?.length || config.only.includes(item.name)));
  check(selected.length, 'No selected cases');
  for (const name of config.only ?? []) check(selected.some(item => item.name === name), `Unknown case ${name}`);
  lib.configureMemory({ maximumBytes: 16 * 1024 * 1024 });
  const offset = rotation % selected.length, order = [...selected.slice(offset), ...selected.slice(0, offset)], rows = [];
  for (const item of order) { collect(); rows.push({ name: item.name, ...await measure(lib, item, config) }); }
  return { gcAvailable: typeof globalThis.gc === 'function' || typeof globalThis.Bun?.gc === 'function', rows };
}
