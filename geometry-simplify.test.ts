import { describe, expect, it, vi } from 'vitest';
import { SharedList } from './shared-list';
import { simplifyLineXY } from './geometry-simplify';
import { getWorkerData, initWorker } from './shared';
const list = (v: number[]) => new SharedList('number').pushMany(v);
describe('simplifyLineXY', () => {
  it('retains endpoints and stable first ties', () => {
    expect([...simplifyLineXY(list([]), 1)]).toEqual([]);
    expect([...simplifyLineXY(list([1,1]), 1)]).toEqual([0]);
    expect([...simplifyLineXY(list([0,0,1,1,2,0]), .5)]).toEqual([0,1,2]);
    expect([...simplifyLineXY(list([0,0,1,1,2,0]), 1)]).toEqual([0,2]);
    expect([...simplifyLineXY(list([1,1,1,1,1,1]), 0)]).toEqual([0,2]);
  });
  it('rejects invalid coordinates and tolerances', () => {
    for (const t of [-1,NaN,Infinity,Number.MAX_VALUE]) expect(() => simplifyLineXY(list([0,0]),t)).toThrow(RangeError);
    expect(() => simplifyLineXY(list([0,NaN]),0)).toThrow(RangeError);
    expect(() => simplifyLineXY(list([0]),0)).toThrow(RangeError);
    expect(() => simplifyLineXY(new SharedList('string') as never,0)).toThrow(TypeError);
  });
  it('does not change attached snapshots after edits and growth', async () => {
    const points=list([0,0,1,1,2,0]),data=getWorkerData({points},{copy:false}),attached=await initWorker(data);
    points.set(2,100).pushMany(Array.from({length:32768},()=>2));
    const before=new Uint8Array(data.arenas[0].memory!.buffer).slice();
    expect([...simplifyLineXY(attached.points,.5)]).toEqual([0,1,2]);
    expect(new Uint8Array(data.arenas[0].memory!.buffer)).toEqual(before);
  });
  it('supports forced scalar selection', async () => {
    vi.resetModules();const validate=vi.spyOn(WebAssembly,'validate').mockReturnValue(false);
    try { const {SharedList:List}=await import('./shared-list');const {simplifyLineXY:reduce}=await import('./geometry-simplify');expect([...reduce(new List('number').pushMany([0,0,1,1,2,0]),.5)]).toEqual([0,1,2]); }
    finally {validate.mockRestore();vi.resetModules();}
  });
});
