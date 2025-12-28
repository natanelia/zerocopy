/**
 * Full d2ts integration with SharedArrayBuffer-backed data structures
 * 
 * Provides:
 * 1. SharedMultiSet - MultiSet backed by SharedArrayBuffer
 * 2. SharedIndex - Index for operator state persistence
 * 3. D2 adapter for worker-parallel pipelines
 */

import { SharedMap } from './shared-map.ts';
import { SharedList } from './shared-list.ts';
import { 
  D2, 
  MultiSet, 
  type IStreamBuilder,
  type Message,
  MessageType,
  output,
  v,
  type Version,
  Antichain,
} from '@electric-sql/d2ts';

// ============================================================================
// 1. SharedMultiSet - MultiSet backed by SharedArrayBuffer
// ============================================================================

type Primitive = string | number | boolean;

function hashValue(v: unknown): string {
  return JSON.stringify(v);
}

export class SharedMultiSet<T> {
  private data: SharedMap<'number'>;

  constructor(entries?: [T, number][]) {
    this.data = new SharedMap('number');
    if (entries) {
      for (const [value, mult] of entries) {
        if (mult !== 0) {
          const key = hashValue(value);
          const current = this.data.get(key) ?? 0;
          this.data = this.data.set(key, current + mult);
        }
      }
    }
  }

  extend(value: T, multiplicity: number): SharedMultiSet<T> {
    const key = hashValue(value);
    const current = this.data.get(key) ?? 0;
    const newMult = current + multiplicity;
    
    const result = new SharedMultiSet<T>();
    result.data = newMult === 0 ? this.data.delete(key) : this.data.set(key, newMult);
    return result;
  }

  getMultiplicity(value: T): number {
    return this.data.get(hashValue(value)) ?? 0;
  }

  *entries(): Generator<[T, number]> {
    for (const [key, mult] of this.data.entries()) {
      yield [JSON.parse(key) as T, mult];
    }
  }

  mapValues<U>(fn: (v: T) => U): SharedMultiSet<U> {
    const result = new SharedMultiSet<U>();
    for (const [value, mult] of this.entries()) {
      const mapped = fn(value);
      const key = hashValue(mapped);
      const current = result.data.get(key) ?? 0;
      result.data = result.data.set(key, current + mult);
    }
    return result;
  }

  filter(predicate: (v: T) => boolean): SharedMultiSet<T> {
    const result = new SharedMultiSet<T>();
    for (const [value, mult] of this.entries()) {
      if (predicate(value)) {
        result.data = result.data.set(hashValue(value), mult);
      }
    }
    return result;
  }

  negate(): SharedMultiSet<T> {
    const result = new SharedMultiSet<T>();
    for (const [key, mult] of this.data.entries()) {
      result.data = result.data.set(key, -mult);
    }
    return result;
  }

  concat(other: SharedMultiSet<T>): SharedMultiSet<T> {
    const result = new SharedMultiSet<T>();
    result.data = this.data;
    
    for (const [value, mult] of other.entries()) {
      const key = hashValue(value);
      const current = result.data.get(key) ?? 0;
      const newMult = current + mult;
      result.data = newMult === 0 ? result.data.delete(key) : result.data.set(key, newMult);
    }
    return result;
  }

  toArray(): [T, number][] {
    return [...this.entries()];
  }

  toMultiSet(): MultiSet<T> {
    return new MultiSet(this.toArray());
  }

  get size(): number {
    return this.data.size;
  }

  /** Get root pointer for zero-copy worker transfer */
  getRoot(): number {
    return (this.data as any).root;
  }

  /** Create from root pointer (zero-copy from worker) */
  static fromRoot<T>(root: number, size: number): SharedMultiSet<T> {
    const result = new SharedMultiSet<T>();
    result.data = new SharedMap('number', root, size);
    return result;
  }

  static fromMultiSet<T>(ms: MultiSet<T>): SharedMultiSet<T> {
    return new SharedMultiSet(ms.getInner());
  }
}

// ============================================================================
// 2. SharedIndex - Versioned state storage backed by SharedArrayBuffer
// ============================================================================

type VersionKey = string;

function versionToKey(v: Version | number): VersionKey {
  return typeof v === 'number' ? `${v}` : v.toString();
}

export class SharedIndex<K, V> {
  // Map: key -> version -> [(value, multiplicity)]
  private inner: Map<string, SharedMap<'string'>> = new Map();
  private keyMap: Map<string, K> = new Map();
  private compactionFrontier: Antichain | null = null;

  private keyToStr(k: K): string {
    return typeof k === 'object' ? JSON.stringify(k) : `${k}`;
  }

  reconstructAt(key: K, requestedVersion: Version): [V, number][] {
    const keyStr = this.keyToStr(key);
    const versions = this.inner.get(keyStr);
    if (!versions) return [];

    const out: [V, number][] = [];
    for (const [versionStr, dataJson] of versions.entries()) {
      const version = v(JSON.parse(versionStr));
      if (version.lessEqual(requestedVersion)) {
        const data: [V, number][] = JSON.parse(dataJson);
        out.push(...data);
      }
    }
    return out;
  }

  versions(key: K): Version[] {
    const keyStr = this.keyToStr(key);
    const versions = this.inner.get(keyStr);
    if (!versions) return [];
    return [...versions.keys()].map(s => v(JSON.parse(s)));
  }

  addValue(key: K, version: Version, value: [V, number]): void {
    const keyStr = this.keyToStr(key);
    this.keyMap.set(keyStr, key);
    
    let versions = this.inner.get(keyStr);
    if (!versions) {
      versions = new SharedMap('string');
      this.inner.set(keyStr, versions);
    }

    const versionStr = JSON.stringify(version.getInner());
    const existing = versions.get(versionStr);
    const data: [V, number][] = existing ? JSON.parse(existing) : [];
    data.push(value);
    this.inner.set(keyStr, versions.set(versionStr, JSON.stringify(data)));
  }

  append(other: SharedIndex<K, V>): void {
    for (const [keyStr, otherVersions] of other.inner) {
      const key = other.keyMap.get(keyStr)!;
      for (const [versionStr, dataJson] of otherVersions.entries()) {
        const data: [V, number][] = JSON.parse(dataJson);
        for (const val of data) {
          this.addValue(key, v(JSON.parse(versionStr)), val);
        }
      }
    }
  }

  keys(): K[] {
    return [...this.keyMap.values()];
  }

  has(key: K): boolean {
    return this.inner.has(this.keyToStr(key));
  }

  compact(compactionFrontier: Antichain, keys: K[] = []): void {
    this.compactionFrontier = compactionFrontier;
    // Simplified compaction - just update frontier
  }

  join<V2>(other: SharedIndex<K, V2>): [Version, MultiSet<[K, [V, V2]]>][] {
    const collections = new Map<string, [K, [V, V2], number][]>();

    for (const [keyStr, versions] of this.inner) {
      if (!other.inner.has(keyStr)) continue;
      const key = this.keyMap.get(keyStr)!;
      const otherVersions = other.inner.get(keyStr)!;

      for (const [v1Str, data1Json] of versions.entries()) {
        const version1 = v(JSON.parse(v1Str));
        const data1: [V, number][] = JSON.parse(data1Json);

        for (const [v2Str, data2Json] of otherVersions.entries()) {
          const version2 = v(JSON.parse(v2Str));
          const data2: [V2, number][] = JSON.parse(data2Json);

          for (const [val1, mul1] of data1) {
            for (const [val2, mul2] of data2) {
              const resultVersion = version1.join(version2);
              const resultKey = JSON.stringify(resultVersion.getInner());
              if (!collections.has(resultKey)) collections.set(resultKey, []);
              collections.get(resultKey)!.push([key, [val1, val2], mul1 * mul2]);
            }
          }
        }
      }
    }

    return [...collections.entries()]
      .filter(([_, c]) => c.length > 0)
      .map(([vStr, data]) => [
        v(JSON.parse(vStr)),
        new MultiSet(data.map(([k, vals, m]) => [[k, vals] as [K, [V, V2]], m])),
      ]);
  }

  /** Get serializable data for worker transfer */
  getSharedData(): { inner: [string, { map: SharedMap<'string'>; entries: [string, string][] }][]; keys: [string, K][] } {
    const inner: [string, { map: SharedMap<'string'>; entries: [string, string][] }][] = [];
    for (const [k, v] of this.inner) {
      inner.push([k, { map: v, entries: [...v.entries()] }]);
    }
    return { inner, keys: [...this.keyMap.entries()] };
  }

  static fromSharedData<K, V>(data: { inner: [string, { map: SharedMap<'string'>; entries: [string, string][] }][]; keys: [string, K][] }): SharedIndex<K, V> {
    const result = new SharedIndex<K, V>();
    result.keyMap = new Map(data.keys);
    for (const [k, v] of data.inner) {
      result.inner.set(k, v.map);
    }
    return result;
  }
}

// ============================================================================
// 3. D2 Adapter for worker-parallel pipelines
// ============================================================================

export interface SharedPipelineResult<T> {
  multiset: SharedMultiSet<T>;
  frontier: number;
}

export interface SharedPipelineConfig {
  initialFrontier?: number;
}

/**
 * Create a d2ts pipeline that outputs to SharedMultiSet
 */
export function createSharedPipeline<TIn, TOut>(
  buildPipeline: (input: IStreamBuilder<TIn>) => IStreamBuilder<TOut>,
  config: SharedPipelineConfig = {}
): {
  graph: D2;
  input: ReturnType<D2['newInput']>;
  getResults: () => SharedMultiSet<TOut>;
  run: (data: [TIn, number][], version?: number) => SharedMultiSet<TOut>;
} {
  const { initialFrontier = 0 } = config;
  const graph = new D2({ initialFrontier });
  const input = graph.newInput<TIn>();
  
  let results = new SharedMultiSet<TOut>();

  const pipeline = buildPipeline(input);
  pipeline.pipe(
    output((message: Message<TOut>) => {
      if (message.type === MessageType.DATA) {
        for (const [value, mult] of message.data.collection.getInner()) {
          results = results.extend(value, mult);
        }
      }
    })
  );

  graph.finalize();

  return {
    graph,
    input,
    getResults: () => results,
    run: (data: [TIn, number][], version = 0) => {
      results = new SharedMultiSet<TOut>();
      input.sendData(version, new MultiSet(data));
      input.sendFrontier(version + 1);
      graph.run();
      return results;
    },
  };
}

/**
 * Worker message types for parallel pipeline execution
 */
export interface WorkerPipelineMessage {
  type: 'init' | 'data' | 'result';
  sharedBuffer?: SharedArrayBuffer;
  data?: unknown;
  version?: number;
}

/**
 * Create worker-shareable pipeline state (zero-copy)
 */
export function getSharedPipelineState<T>(results: SharedMultiSet<T>): { root: number; size: number } {
  return { root: results.getRoot(), size: results.size };
}

/**
 * Reconstruct pipeline state in worker (zero-copy)
 */
export function initSharedPipelineState<T>(data: { root: number; size: number }): SharedMultiSet<T> {
  return SharedMultiSet.fromRoot<T>(data.root, data.size);
}

// Re-export d2ts types for convenience
export { D2, MultiSet, v, Antichain, MessageType, output };
export type { IStreamBuilder, Message, Version };
