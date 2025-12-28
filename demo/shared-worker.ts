import { SharedTodoReader } from './shared-browser';

declare var self: Worker;

type Task = 'count' | 'search' | 'overdue' | 'group';

self.onmessage = async (e: MessageEvent<{ buffer: SharedArrayBuffer; task: Task; now: number }>) => {
  const start = performance.now();
  const reader = new SharedTodoReader(e.data.buffer);
  const initTime = performance.now() - start;
  
  const workStart = performance.now();
  let result: any;
  
  if (e.data.task === 'count') {
    let completed = 0, pending = 0;
    reader.forEach(todo => todo.completed ? completed++ : pending++);
    result = { completed, pending };
  } else if (e.data.task === 'search') {
    let matches = 0;
    reader.forEach(todo => { if (todo.title.includes('urgent')) matches++; });
    result = { matches };
  } else if (e.data.task === 'overdue') {
    let overdue = 0;
    reader.forEach(todo => { if (!todo.completed && todo.dueDate < e.data.now) overdue++; });
    result = { overdue };
  } else if (e.data.task === 'group') {
    const groups: Record<string, number> = {};
    reader.forEach(todo => { groups[todo.category] = (groups[todo.category] || 0) + 1; });
    result = groups;
  }
  
  const workTime = performance.now() - workStart;
  self.postMessage({ task: e.data.task, result, initTime, workTime, total: initTime + workTime });
};
