import { describe, expect, it, vi } from 'vitest';
import { SharedList, resetSharedList } from './shared-list';
import { preparePolygonXY, pointsWithinPolygonXY } from './geometry-polygon';
import { getWorkerData, initWorker } from './shared';
const list = (values: number[]) => new SharedList('number').pushMany(values);
const outerValues = [0,0,10,0,10,10,0,10,0,0];
const holeValues = [3,3,7,3,7,7,3,7,3,3];
describe('prepared XY polygon membership', () => {
  it('returns stable indices with exterior, hole, and boundary rules', () => {
    const polygon = preparePolygonXY([list(outerValues), list(holeValues)]);
    const points = list([1,1,5,5,0,0,3,5,11,1,NaN,2,Infinity,1]);
    expect([...pointsWithinPolygonXY(points, polygon)]).toEqual([0,2,3]);
    expect([...pointsWithinPolygonXY(points, polygon, { ignoreBoundary: true })]).toEqual([0]);
    expect(Object.isFrozen(polygon.bounds)).toBe(true);
  });
  it('handles rings in a different arena without copying query points', () => {
    const polygon = preparePolygonXY([list(outerValues)]); resetSharedList();
    const points = list([1,1,11,1,0,5]);
    expect([...pointsWithinPolygonXY(points, polygon)]).toEqual([0,2]);
  });
  it('retains ring and point snapshots after owner edits and growth', async () => {
    const ring = list(outerValues), points = list([1,1,20,20]);
    const data = getWorkerData({ ring, points }, { copy: false });
    const attached = await initWorker(data);
    const prepared = preparePolygonXY([attached.ring]);
    ring.set(2, 100); points.pushMany(Array.from({ length: 32768 }, () => 1));
    const before = data.arenas.map(a => new Uint8Array(a.memory!.buffer).slice());
    expect([...pointsWithinPolygonXY(attached.points, prepared)]).toEqual([0]);
    data.arenas.forEach((a, i) => expect(new Uint8Array(a.memory!.buffer)).toEqual(before[i]));
  });
  it('rejects malformed geometry and forged prepared objects', () => {
    expect(() => preparePolygonXY([])).toThrow();
    expect(() => preparePolygonXY([list([0,0,1,1])])).toThrow(RangeError);
    expect(() => preparePolygonXY([list([0,0,1,0,1,1,0,1])])).toThrow(RangeError);
    expect(() => preparePolygonXY([list([0,0,Infinity,0,1,1,0,0])])).toThrow(RangeError);
    expect(() => pointsWithinPolygonXY(list([1,1]), {} as never)).toThrow(TypeError);
    expect(() => pointsWithinPolygonXY(list([1]), preparePolygonXY([list(outerValues)]))).toThrow(RangeError);
  });
  it('supports the separately built scalar module', async () => {
    vi.resetModules(); const validate = vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);
    try {
      const { SharedList: List } = await import('./shared-list');
      const { preparePolygonXY: prepare, pointsWithinPolygonXY: select } = await import('./geometry-polygon');
      expect([...select(new List('number').pushMany([1,1,20,20]), prepare([new List('number').pushMany(outerValues)]))]).toEqual([0]);
    } finally { validate.mockRestore(); vi.resetModules(); }
  });
});
