import { beforeEach, describe, expect, it } from 'vitest';
import { SharedMap, getWorkerData, resetMap } from './shared';
import { arenaOf } from './arena';
import { capture, identities } from './worker-protocol';
import { createSharedState } from './worker';

type Descriptor = ReturnType<SharedMap<'number'>['toWorkerData']>;
const emptyDescriptor = (): Descriptor => ({ root: 0, valueType: 'number', size: 0 });

function customMap(serialize: () => Descriptor): SharedMap<'number'> {
  class CustomMap extends SharedMap<'number'> {
    toWorkerData() { return serialize(); }
  }
  return new CustomMap('number');
}

function expectSameError(run: () => unknown, failure: Error): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBe(failure);
}

describe('owner capture identity enumeration', () => {
  beforeEach(() => resetMap());

  it('captures an empty record with frozen null-prototype records', () => {
    const input = {}, result = capture(input);
    expect(result.single).toBe(false);
    expect(result.value).not.toBe(input);
    expect(Object.keys(result.value)).toEqual([]);
    expect(Object.keys(result.identities)).toEqual([]);
    for (const record of [result.value, result.data.structures, result.identities]) {
      expect(Object.getPrototypeOf(record)).toBe(null);
      expect(Object.isFrozen(record)).toBe(true);
    }
  });

  it('distinguishes a single collection from a one-name value record', () => {
    const map = new SharedMap('number').set('a', 7);
    const single = capture(map), record = capture({ value: map });
    const expected = JSON.stringify(['SharedMap', arenaOf(map).id, { root: map.root, valueType: 'number', size: 1 }]);
    expect(single.single).toBe(true);
    expect(single.value).toBe(map);
    expect(record.single).toBe(false);
    expect(record.value.value).toBe(map);
    expect(single.identities.value).toBe(expected);
    expect(record.identities.value).toBe(expected);
  });

  it('captures every name in a wide record without losing aliases', () => {
    const map = new SharedMap('number');
    const input = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`field${i}`, map]));
    const result = capture(input);
    expect(Object.keys(result.identities)).toEqual(Object.keys(input));
    const expected = JSON.stringify(['SharedMap', arenaOf(map).id, emptyDescriptor()]);
    for (const name of Object.keys(input)) {
      expect(result.value[name]).toBe(map);
      expect(result.identities[name]).toBe(expected);
    }
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.identities)).toBe(true);
  });

  it('preserves integer-name order and prototype-like names', () => {
    const map = new SharedMap('number'), input = Object.create(null);
    for (const name of ['10', '2', '01', '__proto__', 'constructor', 'toString', '']) input[name] = map;
    const result = capture(input), names = ['2', '10', '01', '__proto__', 'constructor', 'toString', ''];
    expect(Object.keys(result.value)).toEqual(names);
    expect(Object.keys(result.identities)).toEqual(names);
    for (const name of names) expect(Object.hasOwn(result.identities, name)).toBe(true);
    expect(Object.getPrototypeOf(result.identities)).toBe(null);
  });

  it('finishes descriptor callbacks before ordered JSON callbacks and sees later-data mutations', () => {
    const events: string[] = [];
    const later = { ...emptyDescriptor(), marker: 0 };
    const first = customMap(() => {
      events.push('descriptor:first');
      return { ...emptyDescriptor(), toJSON(key: string) {
        events.push(`json:first:${key}`);
        later.marker = 9;
        return emptyDescriptor();
      } };
    });
    const second = customMap(() => {
      events.push('descriptor:second');
      return new Proxy(later, {
        get(target, key, receiver) { events.push(`get:${String(key)}`); return Reflect.get(target, key, receiver); },
        ownKeys(target) { events.push('keys:second'); return Reflect.ownKeys(target); },
      });
    });
    const result = capture({ first, second });
    expect(events).toEqual([
      'descriptor:first', 'descriptor:second', 'json:first:2',
      'get:toJSON', 'keys:second', 'get:root', 'get:valueType', 'get:size', 'get:marker',
    ]);
    expect(JSON.parse(result.identities.second)[2]).toEqual({ ...emptyDescriptor(), marker: 9 });
  });

  it('re-evaluates the same descriptor object when publishing the same collection', () => {
    let version = 0, calls = 0;
    const descriptor = { ...emptyDescriptor(), toJSON() { calls++; return { ...emptyDescriptor(), version }; } };
    const map = customMap(() => descriptor), state = createSharedState(map);
    try {
      expect(calls).toBe(1);
      expect(state.publish(map)).toBe(0);
      expect(calls).toBe(2);
      version = 1;
      expect(state.publish(map)).toBe(1);
      expect(calls).toBe(3);
      expect(state.current).toBe(map);
      expect(state.flush()).toBe(1);
      expect(calls).toBe(3);
    } finally { state.dispose(); }
  });

  it('propagates a later descriptor failure before any earlier JSON callback', () => {
    const events: string[] = [], failure = new Error('descriptor failed');
    const first = customMap(() => {
      events.push('descriptor:first');
      return { ...emptyDescriptor(), toJSON() { events.push('json:first'); return emptyDescriptor(); } };
    });
    const second = customMap(() => { events.push('descriptor:second'); throw failure; });
    expectSameError(() => capture({ first, second }), failure);
    expect(events).toEqual(['descriptor:first', 'descriptor:second']);
  });

  it.each(['toJSON', 'getter'] as const)('keeps state and version when descriptor %s throws', kind => {
    const failure = new Error(`${kind} failed`), events: string[] = [];
    const good = new SharedMap('number'), state = createSharedState({ first: good, second: good });
    const old = state.current;
    const first = customMap(() => {
      events.push('descriptor:first');
      return kind === 'toJSON'
        ? { ...emptyDescriptor(), toJSON() { events.push('json:first'); throw failure; } }
        : { root: 0, valueType: 'number', get size() { events.push('getter:first'); throw failure; } };
    });
    const second = customMap(() => {
      events.push('descriptor:second');
      return { ...emptyDescriptor(), toJSON() { events.push('json:second'); return emptyDescriptor(); } };
    });
    try {
      expectSameError(() => state.publish({ first, second }), failure);
      expect(events).toEqual(['descriptor:first', 'descriptor:second', kind === 'toJSON' ? 'json:first' : 'getter:first']);
      expect(state.current).toBe(old);
      expect(state.version).toBe(0);
    } finally { state.dispose(); }
  });

  it.each(['cycle', 'bigint'] as const)('preserves JSON rejection for %s descriptor data', kind => {
    const descriptor: any = emptyDescriptor();
    descriptor.extra = kind === 'cycle' ? descriptor : 1n;
    expect(() => capture(customMap(() => descriptor))).toThrow(TypeError);
  });

  it('leaves generic payload identities eager across outer accessors', () => {
    const events: string[] = [];
    const make = (name: string) => customMap(() => ({ ...emptyDescriptor(), toJSON() {
      events.push(`json:${name}`); return emptyDescriptor();
    } }));
    const data = getWorkerData({ first: make('first'), second: make('second') }, { copy: false });
    const structures = {
      get first() { events.push('outer:first'); return data.structures.first; },
      get second() { events.push('outer:second'); return data.structures.second; },
    };
    const result = identities({ ...data, structures });
    expect(events).toEqual(['outer:first', 'outer:second', 'json:first', 'json:second']);
    expect(Object.keys(result)).toEqual(['first', 'second']);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
