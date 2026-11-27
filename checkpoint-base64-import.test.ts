import { deepEqual } from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { SharedList, SharedMap, getWorkerData, initWorker } from './shared';
import { arenaOf } from './arena';
import { decodeZerocopyState, encodeZerocopyState, deserializeZerocopyState } from './redux';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const copyPacket = (value: unknown): any => JSON.parse(JSON.stringify(value));

function packetsByRemainder() {
  const packets = new Map<number, { packet: any; value: string }>();
  for (let length = 0; length < 24 && packets.size < 3; length++) {
    const value = '\0\u007f\u0080街道🙂' + 'x'.repeat(length);
    const packet = copyPacket(encodeZerocopyState(new SharedList('string').push(value)));
    packets.set(packet.arenas[0].used % 3, { packet, value });
  }
  expect([...packets.keys()].sort()).toEqual([0, 1, 2]);
  return packets;
}

describe('byte-oriented checkpoint imports', () => {
  it('preserves all final-byte and padding lengths, including Unicode and NULs', () => {
    for (const [remainder, { packet, value }] of packetsByRemainder()) {
      expect(packet.arenas[0].base64.endsWith('==')).toBe(remainder === 1);
      expect(packet.arenas[0].base64.endsWith('=')).toBe(remainder !== 0);
      const before = JSON.stringify(packet);
      const result = decodeZerocopyState<SharedList<'string'>>(packet);
      expect(result.toArray()).toEqual([value]);
      expect(result.push('later').toArray()).toEqual([value, 'later']);
      expect(result.toArray()).toEqual([value]);
      expect(JSON.stringify(packet)).toBe(before);
    }
  });

  it('keeps atob compatibility for nonzero unused padding bits', () => {
    for (const [remainder, { packet, value }] of packetsByRemainder()) {
      if (!remainder) continue;
      const arena = packet.arenas[0], text = arena.base64;
      const index = text.length - (remainder === 1 ? 3 : 2);
      const changed = alphabet[alphabet.indexOf(text[index]) | 1];
      expect(changed).not.toBe(text[index]);
      arena.base64 = text.slice(0, index) + changed + text.slice(index + 1);
      expect(atob(arena.base64)).toBe(atob(text));
      expect(decodeZerocopyState<SharedList<'string'>>(packet).toArray()).toEqual([value]);
    }
  });

  it.each([
    ['space', (text: string) => text.slice(0, 7) + ' ' + text.slice(8)],
    ['newline', (text: string) => text.slice(0, 7) + '\n' + text.slice(8)],
    ['URL-safe minus', (text: string) => '-' + text.slice(1)],
    ['URL-safe underscore', (text: string) => '_' + text.slice(1)],
    ['Unicode', (text: string) => 'é' + text.slice(1)],
    ['interior padding', (text: string) => text.slice(0, 7) + '=' + text.slice(8)],
    ['excess padding', (text: string) => text.slice(0, -3) + '==='],
    ['truncated input', (text: string) => text.slice(0, -1)],
    ['appended input', (text: string) => text + 'AAAA'],
  ])('rejects %s with the existing base64 validation error', (_name, change) => {
    const packet = copyPacket(encodeZerocopyState(new SharedList('number').push(7)));
    packet.arenas[0].base64 = change(packet.arenas[0].base64);
    expect(() => decodeZerocopyState(packet)).toThrow('zerocopy/redux: invalid base64 arena');
  });

  it('checks the decoded byte count even when encoded length and alphabet pass', () => {
    for (const [remainder, { packet }] of packetsByRemainder()) {
      const arena = packet.arenas[0];
      arena.base64 = remainder ? arena.base64.replace(/=/g, 'A') : arena.base64.slice(0, -1) + '=';
      expect(() => decodeZerocopyState(packet)).toThrow('zerocopy/redux: arena length does not match its data');
    }
  });

  it('keeps coercions when a base64 getter changes from a string to a String-like object', () => {
    const packet = copyPacket(encodeZerocopyState(new SharedList('string').push('retained')));
    const arena = packet.arenas[0], text = arena.base64, reads: string[] = [];
    let count = 0;
    const value = { get length() { reads.push('length'); return text.length; },
      toString() { reads.push('toString'); return text; } };
    Object.defineProperty(arena, 'base64', { enumerable: true, get() {
      reads.push(`base64-${++count}`); return count === 1 ? text : value;
    } });
    expect(decodeZerocopyState<SharedList<'string'>>(packet).toArray()).toEqual(['retained']);
    expect(reads).toEqual(['base64-1', 'base64-2', 'length', 'toString', 'toString']);
  });

  it('rejects corruption and resource limits before reading collection storage', () => {
    const packet = copyPacket(encodeZerocopyState(new SharedList('string').push('retained')));
    packet.arenas[0].base64 = (packet.arenas[0].base64[0] === 'A' ? 'B' : 'A') + packet.arenas[0].base64.slice(1);
    expect(() => decodeZerocopyState(packet, { maxBytes: 1 })).toThrow('arena data exceeds maxBytes');
    expect(() => decodeZerocopyState(packet)).toThrow('arena checksum mismatch');
  });

  it('restores large nested byte payloads into independent writable arenas', async () => {
    const values = Array.from({ length: 80 }, (_, i) => `${i}:` + '路🙂\0'.repeat(1024));
    const child = new SharedList('string').pushMany(values);
    const source = new SharedMap<'SharedList<string>'>('SharedList<string>').set('child', child);
    const packet = encodeZerocopyState({ source, alias: source });
    const text = JSON.stringify(packet), before = arenaOf(source).copy(), childBefore = arenaOf(child).copy();
    const first = decodeZerocopyState<{ source: typeof source; alias: typeof source }>(packet);
    const second = deserializeZerocopyState<typeof first>(text);
    expect(first.source).toBe(first.alias); expect(second.source).toBe(second.alias);
    expect(arenaOf(first.source).id).not.toBe(arenaOf(second.source).id);
    expect(first.source.get('child')!.toArray()).toEqual(values);
    const changed = first.source.set('child', first.source.get('child')!.push('later'));
    expect(changed.get('child')!.size).toBe(values.length + 1);
    expect(first.source.get('child')!.toArray()).toEqual(values);
    expect(second.source.get('child')!.toArray()).toEqual(values);
    const attached = await initWorker<{ changed: typeof source }>(getWorkerData({ changed }, { copy: true }));
    expect(attached.changed.get('child')!.toArray()).toEqual([...values, 'later']);
    expect(() => attached.changed.set('other', child)).toThrow(/read-only/);
    deepEqual(arenaOf(source).copy(), before); deepEqual(arenaOf(child).copy(), childBefore);
    expect(JSON.stringify(packet)).toBe(text);
  });
});
