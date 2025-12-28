declare var self: Worker;

type Task = 'count' | 'search' | 'overdue' | 'group';
interface Todo { id: string; title: string; completed: boolean; category: string; dueDate: number; }

self.onmessage = (e: MessageEvent<{ todos: Todo[]; task: Task; now: number }>) => {
  const start = performance.now();
  const todos = e.data.todos; // Already cloned by postMessage
  const initTime = performance.now() - start;
  
  const workStart = performance.now();
  let result: any;
  
  if (e.data.task === 'count') {
    let completed = 0, pending = 0;
    for (const todo of todos) todo.completed ? completed++ : pending++;
    result = { completed, pending };
  } else if (e.data.task === 'search') {
    const matches = todos.filter(t => t.title.includes('urgent'));
    result = { matches: matches.length };
  } else if (e.data.task === 'overdue') {
    const overdue = todos.filter(t => !t.completed && t.dueDate < e.data.now);
    result = { overdue: overdue.length };
  } else if (e.data.task === 'group') {
    const groups: Record<string, number> = {};
    for (const todo of todos) groups[todo.category] = (groups[todo.category] || 0) + 1;
    result = groups;
  }
  
  const workTime = performance.now() - workStart;
  self.postMessage({ task: e.data.task, result, initTime, workTime, total: initTime + workTime });
};
