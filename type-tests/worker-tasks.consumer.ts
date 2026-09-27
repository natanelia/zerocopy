import { SharedMap, SharedList } from 'zerocopy';
import { createState, type StateOf } from 'zerocopy/state';
import { defineTasks, spawn, connect, pool, serve, local } from 'zerocopy/worker';
const state = createState({ map: new SharedMap('number'), list: new SharedList('string') });
type Model = StateOf<typeof state>;
const tasks = defineTasks<Model>()({
  get({ state }, key: string) { return state.map.get(key); },
  size({ state }) { return state.list.size; },
});
async function proof(worker: Worker, port: MessagePort) {
  const a = await spawn<typeof tasks>(() => worker, { state });
  const b = await connect<typeof tasks>(port, { state });
  const c = await pool<typeof tasks>([worker], { state });
  const d = local(tasks, { state });
  const value: number | undefined = await a.run.get('lane');
  const count: number = await b.run.size();
  const values: (number | undefined)[] = await c.map.get(['lane']);
  const stop = await serve(tasks, { endpoint: port });
  // @ts-expect-error Task state must match the task definition.
  await spawn<typeof tasks>(() => worker, { state: { map: new SharedMap('string'), list: state.current.list } });
  // @ts-expect-error Task input must match.
  a.run.get(123);
  // @ts-expect-error Typed task names do not accept unknown methods.
  b.run.noSuchTask();
  // @ts-expect-error A payload is required for get.
  d.run.get();
  void value; void count; void values; stop(); a.dispose(); b.dispose(); c.dispose(); d.dispose();
}
void proof;
