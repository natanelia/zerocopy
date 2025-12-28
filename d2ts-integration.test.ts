import { describe, it, expect } from 'vitest';
import { 
  SharedMultiSet, 
  SharedIndex,
  createSharedPipeline,
  getSharedPipelineState,
  initSharedPipelineState,
  MultiSet,
  v,
} from './d2ts-integration.ts';
import { map, filter, reduce, keyBy } from '@electric-sql/d2ts';

describe('SharedMultiSet', () => {
  it('creates from entries', () => {
    const ms = new SharedMultiSet<number>([[1, 1], [2, 2], [3, -1]]);
    expect(ms.getMultiplicity(1)).toBe(1);
    expect(ms.getMultiplicity(2)).toBe(2);
    expect(ms.getMultiplicity(3)).toBe(-1);
  });

  it('extends with new values', () => {
    const ms = new SharedMultiSet<number>([[1, 1]]);
    const ms2 = ms.extend(2, 1);
    expect(ms2.getMultiplicity(1)).toBe(1);
    expect(ms2.getMultiplicity(2)).toBe(1);
  });

  it('consolidates on extend (removes zeros)', () => {
    const ms = new SharedMultiSet<number>([[1, 1]]);
    const ms2 = ms.extend(1, -1);
    expect(ms2.getMultiplicity(1)).toBe(0);
    expect(ms2.size).toBe(0);
  });

  it('maps values', () => {
    const ms = new SharedMultiSet<number>([[1, 1], [2, 1]]);
    const mapped = ms.mapValues(x => x * 10);
    expect(mapped.getMultiplicity(10)).toBe(1);
    expect(mapped.getMultiplicity(20)).toBe(1);
  });

  it('filters values', () => {
    const ms = new SharedMultiSet<number>([[1, 1], [2, 1], [3, 1]]);
    const filtered = ms.filter(x => x > 1);
    expect(filtered.getMultiplicity(1)).toBe(0);
    expect(filtered.getMultiplicity(2)).toBe(1);
    expect(filtered.getMultiplicity(3)).toBe(1);
  });

  it('negates multiplicities', () => {
    const ms = new SharedMultiSet<number>([[1, 1], [2, -1]]);
    const negated = ms.negate();
    expect(negated.getMultiplicity(1)).toBe(-1);
    expect(negated.getMultiplicity(2)).toBe(1);
  });

  it('concatenates multisets', () => {
    const ms1 = new SharedMultiSet<number>([[1, 1], [2, 1]]);
    const ms2 = new SharedMultiSet<number>([[2, 1], [3, 1]]);
    const concat = ms1.concat(ms2);
    expect(concat.getMultiplicity(1)).toBe(1);
    expect(concat.getMultiplicity(2)).toBe(2);
    expect(concat.getMultiplicity(3)).toBe(1);
  });

  it('handles object values', () => {
    const ms = new SharedMultiSet<{id: number}>([[{id: 1}, 1], [{id: 2}, 2]]);
    expect(ms.getMultiplicity({id: 1})).toBe(1);
    expect(ms.getMultiplicity({id: 2})).toBe(2);
  });

  it('converts to/from d2ts MultiSet', () => {
    const shared = new SharedMultiSet<number>([[1, 1], [2, 2]]);
    const d2tsMs = shared.toMultiSet();
    expect(d2tsMs.getInner()).toEqual(expect.arrayContaining([[1, 1], [2, 2]]));
    
    const backToShared = SharedMultiSet.fromMultiSet(d2tsMs);
    expect(backToShared.getMultiplicity(1)).toBe(1);
    expect(backToShared.getMultiplicity(2)).toBe(2);
  });

  it('serializes and deserializes', () => {
    const ms = new SharedMultiSet<number>([[1, 1], [2, 2]]);
    const { root, size } = { root: ms.getRoot(), size: ms.size };
    const restored = SharedMultiSet.fromRoot<number>(root, size);
    expect(restored.getMultiplicity(1)).toBe(1);
    expect(restored.getMultiplicity(2)).toBe(2);
  });
});

describe('SharedIndex', () => {
  it('stores and retrieves versioned values', () => {
    const index = new SharedIndex<string, number>();
    index.addValue('key1', v(0), [100, 1]);
    index.addValue('key1', v(1), [200, 1]);
    
    const atV0 = index.reconstructAt('key1', v(0));
    expect(atV0).toEqual([[100, 1]]);
    
    const atV1 = index.reconstructAt('key1', v(1));
    expect(atV1).toEqual(expect.arrayContaining([[100, 1], [200, 1]]));
  });

  it('tracks versions for keys', () => {
    const index = new SharedIndex<string, number>();
    index.addValue('key1', v(0), [100, 1]);
    index.addValue('key1', v(2), [200, 1]);
    
    const versions = index.versions('key1');
    expect(versions.length).toBe(2);
  });

  it('appends from another index', () => {
    const index1 = new SharedIndex<string, number>();
    index1.addValue('key1', v(0), [100, 1]);
    
    const index2 = new SharedIndex<string, number>();
    index2.addValue('key1', v(1), [200, 1]);
    index2.addValue('key2', v(0), [300, 1]);
    
    index1.append(index2);
    
    expect(index1.has('key1')).toBe(true);
    expect(index1.has('key2')).toBe(true);
    expect(index1.reconstructAt('key1', v(1))).toEqual(expect.arrayContaining([[100, 1], [200, 1]]));
  });

  it('joins two indexes', () => {
    const index1 = new SharedIndex<string, number>();
    index1.addValue('k', v(0), [1, 1]);
    
    const index2 = new SharedIndex<string, string>();
    index2.addValue('k', v(0), ['a', 1]);
    
    const joined = index1.join(index2);
    expect(joined.length).toBe(1);
    expect(joined[0][1].getInner()).toEqual([[['k', [1, 'a']], 1]]);
  });
});

describe('createSharedPipeline', () => {
  it('creates pipeline with shared output', () => {
    const { run } = createSharedPipeline<number, number>(
      (input) => input.pipe(
        map((x: number) => x + 5),
        filter((x: number) => x % 2 === 0)
      )
    );
    
    const results = run([[1, 1], [2, 1], [3, 1]]);
    // 1+5=6 (even), 2+5=7 (odd), 3+5=8 (even)
    expect(results.getMultiplicity(6)).toBe(1);
    expect(results.getMultiplicity(8)).toBe(1);
    expect(results.size).toBe(2);
  });

  it('handles incremental updates', () => {
    const { graph, input, getResults } = createSharedPipeline<number, number>(
      (inp) => inp.pipe(map((x: number) => x * 2))
    );
    
    input.sendData(0, new MultiSet([[1, 1], [2, 1]]));
    input.sendFrontier(1);
    graph.run();
    
    const results = getResults();
    expect(results.getMultiplicity(2)).toBe(1);
    expect(results.getMultiplicity(4)).toBe(1);
  });

  it('handles complex objects', () => {
    const { run } = createSharedPipeline<
      { name: string; score: number },
      { name: string; score: number }
    >(
      (input) => input.pipe(filter((x) => x.score > 50))
    );
    
    const results = run([
      [{ name: 'alice', score: 80 }, 1],
      [{ name: 'bob', score: 40 }, 1],
      [{ name: 'charlie', score: 90 }, 1],
    ]);
    
    expect(results.size).toBe(2);
    expect(results.getMultiplicity({ name: 'alice', score: 80 })).toBe(1);
    expect(results.getMultiplicity({ name: 'charlie', score: 90 })).toBe(1);
  });

  it('pipeline state serialization roundtrip', () => {
    const { run } = createSharedPipeline<number, number>(
      (input) => input.pipe(map((x: number) => x * 10))
    );
    
    const results = run([[1, 1], [2, 1]]);
    const sharedState = getSharedPipelineState(results);
    const restored = initSharedPipelineState<number>(sharedState);
    
    expect(restored.getMultiplicity(10)).toBe(1);
    expect(restored.getMultiplicity(20)).toBe(1);
  });
});

describe('differential semantics', () => {
  it('models insert/delete with multiplicities', () => {
    let state = new SharedMultiSet<string>([['a', 1], ['b', 1]]);
    const change = new SharedMultiSet<string>([['a', -1], ['c', 1]]);
    state = state.concat(change);
    
    expect(state.getMultiplicity('a')).toBe(0);
    expect(state.getMultiplicity('b')).toBe(1);
    expect(state.getMultiplicity('c')).toBe(1);
  });

  it('handles incremental map computation', () => {
    const v0 = new SharedMultiSet<number>([[1, 1], [2, 1]]);
    const mapped0 = v0.mapValues(x => x * 10);
    
    const delta1 = new SharedMultiSet<number>([[3, 1], [1, -1]]);
    const mappedDelta1 = delta1.mapValues(x => x * 10);
    
    const result = mapped0.concat(mappedDelta1);
    expect(result.getMultiplicity(10)).toBe(0);
    expect(result.getMultiplicity(20)).toBe(1);
    expect(result.getMultiplicity(30)).toBe(1);
  });

  it('aggregation with reduce', () => {
    type Sale = { product: string; amount: number };
    
    const { run } = createSharedPipeline<Sale, [string, number]>(
      (input) => input.pipe(
        keyBy((s: Sale) => s.product),
        reduce((vals: [Sale, number][]) => {
          let total = 0;
          for (const [sale, mult] of vals) {
            total += sale.amount * mult;
          }
          return [[total, 1]];
        }),
        map(([key, val]) => [key, val] as [string, number])
      )
    );
    
    const results = run([
      [{ product: 'apple', amount: 10 }, 1],
      [{ product: 'apple', amount: 20 }, 1],
      [{ product: 'banana', amount: 15 }, 1],
    ]);
    
    // apple: 10 + 20 = 30, banana: 15
    expect(results.getMultiplicity(['apple', 30])).toBe(1);
    expect(results.getMultiplicity(['banana', 15])).toBe(1);
  });
});
