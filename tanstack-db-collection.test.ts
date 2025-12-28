import { describe, it, expect } from 'vitest';
import { SharedCollection, sharedCollectionConfig } from './tanstack-db-collection.ts';

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

  it('zero-copy worker transfer via root pointer', () => {
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

  it('supports worker state sharing', () => {
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
