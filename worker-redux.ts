/** Optional store adapter. Redux is a structural interface, not a runtime dependency. */
import { createSharedSession, type SharedSource, type SharedValue, type SharedSession, type StateOptions } from './worker';
export interface ReduxSourceStore<State> {
  getState(): State;
  subscribe(listener: () => void): () => void;
}
export interface BindReduxOptions<State, Selected extends SharedValue> extends StateOptions {
  select: (state: State) => Selected;
}
export function reduxSource<State, Selected extends SharedValue>(
  store: ReduxSourceStore<State>, select: (state: State) => Selected,
): SharedSource<Selected> {
  return {
    getSnapshot: () => select(store.getState()),
    subscribe: listener => store.subscribe(listener),
  };
}
export function bindRedux<State, Selected extends SharedValue>(
  store: ReduxSourceStore<State>, options: BindReduxOptions<State, Selected>,
): SharedSession<Selected> {
  const { select, ...sessionOptions } = options;
  return createSharedSession({ source: reduxSource(store, select) }, sessionOptions);
}
