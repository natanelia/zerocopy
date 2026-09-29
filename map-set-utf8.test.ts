import { describe, expect, it } from 'vitest';
import { Arena, arenaOf } from './arena';
import { SharedMap, resetMap } from './shared-map';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const stored = (text: string) => decoder.decode(encoder.encode(text));
function reader(map: SharedMap<'string'>) {
  const a = arenaOf(map);
  return SharedMap.fromWorkerData(map.root, 'string', map.size,
    new Arena({ memory: a.memory, used: a.used, readOnly: true }));
}

describe('direct UTF-8 scalar writes', () => {
  it('matches encoded values across key and value character classes', () => {
    resetMap();
    const texts = ['', 'ascii', '\0', 'a\0b', 'é', '界', '🙂', '\ufeffx', '\ud800', '\udc00', 'a\ud800b', '🙂界é'];
    let map = new SharedMap('string');
    const model = new Map<string, string>();
    for (let i = 0; i < texts.length; i++) for (let j = 0; j < texts.length; j++) {
      const key = `${i}:${texts[i]}:${j}`, value = texts[j];
      map = map.set(key, value); model.set(stored(key), stored(value));
    }
    const independent = reader(map);
    expect(map.size).toBe(model.size);
    for (const [key, value] of model) { expect(map.get(key)).toBe(value); expect(independent.get(key)).toBe(value); }
  });

  it('keeps cached strings consistent with replacement of unpaired surrogates', () => {
    resetMap(); let map = new SharedMap('string').set('key', 'initial').set('路', 'initial');
    expect(map.get('key')).toBe('initial'); expect(map.get('路')).toBe('initial');
    const base = map;
    for (const value of ['\ud800', '\udc00', 'a\ud800b', '\ud800\ud800', '🙂', '\ufeff']) {
      map = map.set('key', value).set('路', value);
      expect(map.get('key')).toBe(stored(value)); expect(map.get('路')).toBe(stored(value));
      expect(reader(map).get('key')).toBe(stored(value)); expect(reader(map).get('路')).toBe(stored(value));
    }
    expect(base.get('key')).toBe('initial');
  });

  it('uses the complete scratch range without writing into old payloads', () => {
    resetMap(); const base = new SharedMap('string').set('old', 'kept');
    const a = arenaOf(base), end = a.used, bytes = a.buf.slice(65536, end);
    const value = '界'.repeat(16383); // Three key bytes + 49,149 value bytes.
    const next = base.set('路', value);
    expect(reader(next).get('路')).toBe(value); expect(next.size).toBe(2);
    expect(a.buf.slice(65536, end)).toEqual(bytes); expect(base.has('路')).toBe(false);
  });

  it.each([16383, 16384, 16385])('handles encoded key boundaries at %i BMP characters', count => {
    resetMap(); const key = '界'.repeat(count), value = '🙂';
    const base = new SharedMap('string').set('old', 'kept');
    const next = base.set(key, value).set('after', 'readable');
    expect(reader(next).get(key)).toBe(value); expect(next.get('after')).toBe('readable');
    expect(base.size).toBe(1); expect(next.size).toBe(3);
  });

  it.each([12287, 12288, 12289])('handles encoded value boundaries at %i supplementary characters', count => {
    resetMap(); const value = '🙂'.repeat(count);
    const base = new SharedMap('string').set('base', 'kept');
    const next = base.set('路', value).set('after', 'readable');
    expect(reader(next).get('路')).toBe(value); expect(next.get('after')).toBe('readable');
    expect(base.size).toBe(1); expect(next.size).toBe(3);
  });

  it('preserves alias keys, cached values, and retained roots after bulk changes', () => {
    resetMap(); const base = new SharedMap('string').set('\ud800', 'old');
    expect(base.get('\ufffd')).toBe('old');
    const first = base.set('\ufffd', '界').setMany([['路', 'first'], ['second', '🙂']]);
    const next = first.set('\udc00', 'new').set('路', 'changed');
    expect(next.size).toBe(3); expect(reader(next).get('\ufffd')).toBe('new');
    expect(reader(first).get('\ufffd')).toBe('界'); expect(base.get('\ud800')).toBe('old');
  });

  it('rejects writes through an independently attached read-only view', () => {
    resetMap(); const map = new SharedMap('string').set('路', '🙂'), attached = reader(map);
    expect(() => attached.set('路', 'new')).toThrow(/read-only/);
    expect(() => attached.set('路', '🙂')).toThrow(/read-only/);
    expect(map.get('路')).toBe('🙂'); expect(Object.isFrozen(map)).toBe(true);
  });
});
