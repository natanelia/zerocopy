import { describe, it, expect } from 'vitest';
import { SharedMap, getWorkerData, initWorker } from './shared-browser';

describe('Demo Worker Data', () => {
  it('serializes and deserializes worker data', async () => {
    await SharedMap.init();
    
    // Create todos
    let todos = new SharedMap('object');
    for (let i = 0; i < 100; i++) {
      todos = todos.set(`todo-${i}`, { 
        id: `todo-${i}`, 
        title: `Task ${i}`,
        completed: i % 3 === 0,
        category: 'work',
        dueDate: Date.now()
      });
    }
    
    // Serialize
    const workerData = getWorkerData({ todos });
    expect(workerData.__shared).toBe(true);
    expect(workerData.mapBuffer).toBeInstanceOf(SharedArrayBuffer);
    
    // Deserialize (simulating worker receiving data)
    const { todos: restored } = await initWorker<{ todos: SharedMap<'object'> }>(workerData);
    
    // Verify data is accessible
    expect(restored.size).toBe(100);
    expect(restored.get('todo-0')).toEqual({
      id: 'todo-0',
      title: 'Task 0',
      completed: true,
      category: 'work',
      dueDate: expect.any(Number)
    });
    
    // Verify forEach works
    let count = 0;
    restored.forEach(() => count++);
    expect(count).toBe(100);
  });

  it('performs count task on shared data', async () => {
    await SharedMap.init();
    
    let todos = new SharedMap('object');
    for (let i = 0; i < 1000; i++) {
      todos = todos.set(`todo-${i}`, { 
        id: `todo-${i}`, 
        completed: i % 3 === 0
      });
    }
    
    const workerData = getWorkerData({ todos });
    const { todos: restored } = await initWorker<{ todos: SharedMap<'object'> }>(workerData);
    
    // Simulate count task
    let completed = 0, pending = 0;
    restored.forEach((todo: any) => todo.completed ? completed++ : pending++);
    
    expect(completed + pending).toBe(1000);
    expect(completed).toBe(334); // Every 3rd is completed (0, 3, 6, ...)
  });

  it('performs search task on shared data', async () => {
    await SharedMap.init();
    
    let todos = new SharedMap('object');
    for (let i = 0; i < 100; i++) {
      todos = todos.set(`todo-${i}`, { 
        id: `todo-${i}`, 
        title: `Task ${i}${i % 10 === 0 ? ' - urgent' : ''}`
      });
    }
    
    const workerData = getWorkerData({ todos });
    const { todos: restored } = await initWorker<{ todos: SharedMap<'object'> }>(workerData);
    
    // Simulate search task
    const matches: string[] = [];
    restored.forEach((todo: any) => {
      if (todo.title.includes('urgent')) matches.push(todo.id);
    });
    
    expect(matches.length).toBe(10); // 0, 10, 20, ..., 90
  });

  it('performs group task on shared data', async () => {
    await SharedMap.init();
    
    const categories = ['work', 'personal', 'shopping'];
    let todos = new SharedMap('object');
    for (let i = 0; i < 90; i++) {
      todos = todos.set(`todo-${i}`, { 
        id: `todo-${i}`, 
        category: categories[i % 3]
      });
    }
    
    const workerData = getWorkerData({ todos });
    const { todos: restored } = await initWorker<{ todos: SharedMap<'object'> }>(workerData);
    
    // Simulate group task
    const groups: Record<string, number> = {};
    restored.forEach((todo: any) => {
      groups[todo.category] = (groups[todo.category] || 0) + 1;
    });
    
    expect(groups).toEqual({ work: 30, personal: 30, shopping: 30 });
  });

  it('zero-copy: same SharedArrayBuffer after serialization', async () => {
    await SharedMap.init();
    
    let todos = new SharedMap('object');
    todos = todos.set('test', { value: 42 });
    
    const buffer1 = SharedMap.getSharedBuffer();
    const workerData = getWorkerData({ todos });
    const buffer2 = workerData.mapBuffer;
    
    // Same buffer reference = zero-copy
    expect(buffer1).toBe(buffer2);
  });
});
