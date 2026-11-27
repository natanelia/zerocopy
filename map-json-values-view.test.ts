import { describe, expect, it } from 'vitest';
import { SharedMap, json, resetMap } from './shared';

describe('SharedMap.valuesView', () => {
  it('yields independent views in snapshot order without changing values', () => {
    resetMap();
    const keys = ['costarring', 'liquid', 'full-collision-0-U<EY?', 'full-collision-1-kJ5Nk', '道路', 'é', 'e\u0301', '🚗', ''];
    const original = new SharedMap(json<{ id: number; label: string; nested: { x: number } }>()).setMany(
      keys.map((label, id) => [label, { id, label, nested: { x: id } }] as const),
    );
    const expected = [...original.values()];
    const iterator = original.valuesView();
    const first = iterator.next().value!;
    const fork = original.delete(keys[0]).set(keys[1], { id: 100, label: 'updated', nested: { x: 42 } });
    const all = [first, ...iterator];
    expect(all.map(view => view.toObject())).toEqual(expected);
    expect(all.map(view => view.get('id'))).toEqual(expected.map(row => row.id));
    expect(first.toObject()).toEqual(expected[0]);
    expect(original.valuesView().next().value).not.toBe(first);
    expect([...fork.valuesView()].map(view => view.toObject())).toEqual([...fork.values()]);
  });

  it('supports empty object maps and rejects non-object codecs', () => {
    expect([...new SharedMap('object').valuesView()]).toEqual([]);
    const wrong = new SharedMap('number') as unknown as SharedMap<'object'>;
    expect(() => wrong.valuesView().next()).toThrow(TypeError);
    const populated = new SharedMap('number').set('x', 1) as unknown as SharedMap<'object'>;
    expect(() => populated.valuesView().next()).toThrow(TypeError);
  });
});
