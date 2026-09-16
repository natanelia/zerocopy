import { SharedMap, SharedList } from 'zerocopy';
import { createSharedState, createSharedSession, connectSharedSession, type SharedSource } from 'zerocopy/worker';
import { bindRedux } from 'zerocopy/redux';
import { Worker as NodeWorker, MessageChannel as NodeChannel } from 'node:worker_threads';
interface State { map: SharedMap<'number'>; list: SharedList<'string'> }
const initial: State = { map: new SharedMap('number'), list: new SharedList('string') };
const shared = createSharedState(initial);
shared.update('map', map => map.set('x', 1));
shared.update(current => ({ ...current, list: current.list.push('value') }));
shared.value = initial;
// @ts-expect-error Unknown key.
shared.update('missing', map => map);
// @ts-expect-error Map expects numeric values.
shared.update('map', map => map.set('x', 'wrong'));
// @ts-expect-error Recipes are synchronous.
shared.update(async current => current);
// @ts-expect-error Records can contain only shared collections.
createSharedState({ bad: 3 });
const single = createSharedState(new SharedMap('number'));
// @ts-expect-error Single collections do not support keyed updates.
single.update('root', root => root);
const source: SharedSource<State> = { getSnapshot: () => initial, subscribe: () => () => {} };
const session = createSharedSession({ source });
const numberValue: number | undefined = session.current.map.get('x');
void numberValue;
const store = { getState: () => ({ ...initial, panel: false }), subscribe: (_listener: () => void) => () => {} };
const bound = bindRedux(store, { select: state => ({ map: state.map }) });
const selected: SharedMap<'number'> = bound.current.map;
void selected;
async function consumers(browser: Worker, node: NodeWorker, port: MessagePort, nodePort: NodeChannel['port1']) {
  await shared.connect([browser, node, port, nodePort]);
  const reader = await connectSharedSession<State>({ endpoint: port });
  const value: number | undefined = reader.current.map.get('x');
  void value;
  for await (const snapshot of reader.snapshots()) { const list: SharedList<'string'> = snapshot.list; void list; break; }
  reader.dispose();
}
void consumers;
shared.dispose(); session.dispose(); single.dispose(); bound.dispose();
