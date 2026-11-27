import { describe, it, expect } from 'vitest';
import { SharedCollection, sharedCollectionConfig, withSharedCache } from './tanstack-db-collection.ts';

type Todo = { id: string; text: string; completed: boolean };

describe('SharedCollection', () => {
  it('inserts and retrieves items', () => {
    let col = new SharedCollection<Todo>('todos');
    col = col.insert({ id: '1', text: 'Test', completed: false });
    
    expect(col.get('1')).toEqual({ id: '1', text: 'Test', completed: false });
    expect(col.size).toBe(1);
  });

  it('updates items immutably', () => {
    let col = new SharedCollection<Todo>('todos');
    col = col.insert({ id: '1', text: 'Test', completed: false });
    
    const col2 = col.update('1', { completed: true });
    
    expect(col.get('1')?.completed).toBe(false);
    expect(col2.get('1')?.completed).toBe(true);
  });

  it('deletes items', () => {
    let col = new SharedCollection<Todo>('todos');
    col = col.insert({ id: '1', text: 'Test', completed: false });
    col = col.delete('1');
    
    expect(col.get('1')).toBeUndefined();
    expect(col.size).toBe(0);
  });

  it('converts to array', () => {
    let col = new SharedCollection<Todo>('todos');
    col = col.insert({ id: '1', text: 'A', completed: false });
    col = col.insert({ id: '2', text: 'B', completed: true });
    
    const arr = col.toArray();
    expect(arr.length).toBe(2);
    expect(arr.map(t => t.id).sort()).toEqual(['1', '2']);
  });

  it('restores a root in the same default arena', () => {
    let col = new SharedCollection<Todo>('todos');
    col = col.insert({ id: '1', text: 'Test', completed: false });
    col = col.insert({ id: '2', text: 'Test2', completed: true });
    
    const root = col.getRoot();
    const size = col.size;
    
    const workerCol = SharedCollection.fromRoot<Todo>('todos', root, size);
    
    expect(workerCol.get('1')).toEqual({ id: '1', text: 'Test', completed: false });
    expect(workerCol.get('2')).toEqual({ id: '2', text: 'Test2', completed: true });
    expect(workerCol.size).toBe(2);
  });
});

describe('sharedCollectionConfig', () => {
  it('provides TanStack DB SyncConfig interface', () => {
    const config = sharedCollectionConfig<Todo>({ id: 'todos' });
    
    expect(config.id).toBe('todos');
    expect(config.primaryKey).toBe('id');
    expect(typeof config.sync.sync).toBe('function');
    expect(config.startSync).toBe(true);
  });

  it('sync loads initial data', () => {
    const config = sharedCollectionConfig<Todo>({
      id: 'todos',
      initialData: [{ id: '1', text: 'Test', completed: false }],
    });
    
    const writes: Array<{ type: string; value?: Todo }> = [];
    let began = false, committed = false, ready = false;
    
    config.sync.sync({
      begin: () => { began = true; },
      write: (msg) => { writes.push(msg); },
      commit: () => { committed = true; },
      markReady: () => { ready = true; },
    });
    
    expect(began).toBe(true);
    expect(committed).toBe(true);
    expect(ready).toBe(true);
    expect(writes).toEqual([{ type: 'insert', value: { id: '1', text: 'Test', completed: false } }]);
  });

  it('exposes the local root descriptor', () => {
    const config = sharedCollectionConfig<Todo>({
      id: 'todos',
      initialData: [{ id: '1', text: 'Test', completed: false }],
    });
    
    // Initialize sync
    config.sync.sync({ begin: () => {}, write: () => {}, commit: () => {}, markReady: () => {} });
    
    const state = config.getSharedState();
    expect(state.id).toBe('todos');
    expect(typeof state.root).toBe('number');
  });
});

describe('withSharedCache', () => {
  it('mirrors upstream sync writes to SharedArrayBuffer', () => {
    // Simulate upstream sync (e.g., Electric)
    const upstreamSync = {
      sync: (params: any) => {
        params.begin();
        params.write({ type: 'insert', value: { id: '1', text: 'From Electric', completed: false } });
        params.write({ type: 'insert', value: { id: '2', text: 'Another', completed: true } });
        params.commit();
        params.markReady();
      },
    };

    const cached = withSharedCache<Todo>(upstreamSync);
    
    // Trigger sync
    const writes: any[] = [];
    cached.sync.sync({
      begin: () => {},
      write: (msg) => writes.push(msg),
      commit: () => {},
      markReady: () => {},
    });

    // Upstream writes passed through
    expect(writes.length).toBe(2);
    
    // Cache populated
    expect(cached.get('1')).toEqual({ id: '1', text: 'From Electric', completed: false });
    expect(cached.get('2')).toEqual({ id: '2', text: 'Another', completed: true });
    expect(cached.toArray().length).toBe(2);
  });

  it('handles updates and deletes', () => {
    const upstreamSync = {
      sync: (params: any) => {
        params.begin();
        params.write({ type: 'insert', value: { id: '1', text: 'Original', completed: false } });
        params.commit();
        
        params.begin();
        params.write({ type: 'update', value: { id: '1', text: 'Updated', completed: true } });
        params.commit();
        
        params.begin();
        params.write({ type: 'delete', key: '1' });
        params.commit();
        params.markReady();
      },
    };

    const cached = withSharedCache<Todo>(upstreamSync);
    cached.sync.sync({ begin: () => {}, write: () => {}, commit: () => {}, markReady: () => {} });

    expect(cached.get('1')).toBeUndefined();
    expect(cached.toArray().length).toBe(0);
  });

  it('restores cached rows in the same default arena', () => {
    const upstreamSync = {
      sync: (params: any) => {
        params.begin();
        params.write({ type: 'insert', value: { id: '1', text: 'Test', completed: false } });
        params.commit();
        params.markReady();
      },
    };

    const cached = withSharedCache<Todo>(upstreamSync);
    cached.sync.sync({ begin: () => {}, write: () => {}, commit: () => {}, markReady: () => {} });

    const state = cached.getSharedState();
    expect(typeof state.root).toBe('number');
    expect(state.size).toBe(1);

    // Reconstruct in the same default arena.
    const workerCached = withSharedCache<Todo>({ sync: () => {} });
    workerCached.fromSharedState(state);
    
    expect(workerCached.get('1')).toEqual({ id: '1', text: 'Test', completed: false });
  });
});

it('mirrors an upstream custom key including empty keys and value-based deletes', () => {
  const item = { id: 'internal', slug: '', text: 'Road', completed: true };
  const cache = withSharedCache<typeof item>({
    sync({ begin, write, commit }) {
      begin();
      write({ type: 'insert', value: item });
      commit();
      expect(cache.get('')).toEqual(item);
      expect(cache.get('internal')).toBeUndefined();
      begin();
      write({ type: 'delete', value: item });
      commit();
    },
  }, { primaryKey: 'slug' });
  cache.sync.sync({ begin() {}, write() {}, commit() {}, markReady() {} });
  expect(cache.getCache().size).toBe(0);
});
