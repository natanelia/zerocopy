import { product } from '../../website/assets/catalog-core.mjs';

export function fingerprint(text, hash = 2166136261) {
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return hash;
}

export function makeFixture(kind, count = 10000) {
  const encoder = new TextEncoder(), records = [], offsets = new Uint32Array(count + 1);
  let expectedHash = 2166136261, bytes = 0, expectedCount = 0;
  for (let i = 0; i < count; i++) {
    let value;
    const original = product(i);
    if (kind === 'catalog') value = original;
    else if (kind === 'unicode') value = { ...original, name: `商品🙂 é ß Σ \"quoted\" \\ ${i}`, description: '道路🛣️ café\n'.repeat(20) };
    else if (kind === 'numeric') value = { category: original.category, revision: i, coordinates: Array.from({length:128}, (_,j) => Math.sin(i + j) * 123.456789) };
    else if (kind === 'large-early') value = { category: original.category, revision: i, payload: `large text ${i} ` + 'abcdefghij'.repeat(400), metadata: original.metadata };
    else if (kind === 'large-late') value = { payload: `large text ${i} ` + 'abcdefghij'.repeat(400), metadata: original.metadata, revision: i, category: original.category };
    else throw Error(`Unknown fixture ${kind}`);
    const json = JSON.stringify(value), encoded = encoder.encode(json);
    offsets[i] = bytes; bytes += encoded.length; records.push(encoded);
    expectedHash = fingerprint(json + '\n', expectedHash);
    if (value.category === 'books') expectedCount++;
  }
  offsets[count] = bytes;
  const buffer = new SharedArrayBuffer(bytes), data = new Uint8Array(buffer);
  records.forEach((record, i) => data.set(record, offsets[i]));
  return {kind, count, buffer, offsets, expectedHash, expectedCount, bytes};
}
