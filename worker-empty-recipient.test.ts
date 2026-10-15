import { afterEach, describe, expect, it } from 'vitest';
import { SharedMap } from './shared';
import { createSharedState, type SharedState, type StateOptions } from './worker';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function drain() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

describe('empty publication recipients', () => {
  it.each(['immediate', 'microtask'] as const)('advances recipient-free state and version with %s publication', async strategy => {
    const original = new SharedMap('number').set('x', 0);
    const first = original.set('x', 1), second = first.set('x', 2);
    const state = createSharedState(original, { publish: { strategy } });
    cleanup.push(() => state.dispose());

    state.update(() => first);
    expect(state.current).toBe(first);
    expect(state.version).toBe(strategy === 'immediate' ? 1 : 0);
    expect(state.flush()).toBe(1);
    await drain();
    expect(state.version).toBe(1);
    expect(state.publish(second)).toBe(2);
    expect(state.getSnapshot()).toBe(second);
    expect(state.flush()).toBe(2);
    expect(state.closed).toBe(false);
    expect(original.get('x')).toBe(0);
    expect(first.get('x')).toBe(1);
  });

  it('notifies a subscriber installed by the onError getter for that publication', () => {
    const original = new SharedMap('number').set('x', 0);
    const first = original.set('x', 1), second = first.set('x', 2);
    const seen: [number, number][] = [];
    let state!: SharedState<SharedMap<'number'>>, reads = 0, unsubscribe = () => {};
    const options: StateOptions = {
      get onError() {
        reads++;
        if (reads === 1) unsubscribe = state.subscribe((map, version) => seen.push([version, map.get('x')!]));
        return undefined;
      },
    };
    state = createSharedState(original, options);
    cleanup.push(() => state.dispose());

    expect(reads).toBe(0);
    expect(state.publish(first)).toBe(1);
    expect(reads).toBe(1);
    expect(seen).toEqual([[1, 1]]);
    unsubscribe();
    expect(state.publish(second)).toBe(2);
    expect(reads).toBe(2);
    expect(seen).toEqual([[1, 1]]);
  });

  it('keeps outer snapshot and return version when the onError getter publishes recursively', () => {
    const original = new SharedMap('number').set('x', 0);
    const first = original.set('x', 1), second = first.set('x', 2);
    const seen: [number, number][] = [];
    let state!: SharedState<SharedMap<'number'>>, reads = 0, innerVersion = -1;
    state = createSharedState(original, {
      get onError() {
        if (++reads === 1) innerVersion = state.publish(second);
        return undefined;
      },
    });
    cleanup.push(() => state.dispose());
    state.subscribe((map, version) => seen.push([version, map.get('x')!]));

    expect(state.publish(first)).toBe(1);
    expect(innerVersion).toBe(2);
    expect(reads).toBe(2);
    expect(state.current).toBe(second);
    expect(state.version).toBe(2);
    expect(seen).toEqual([[2, 2], [1, 1]]);
    expect(state.flush()).toBe(2);
  });

  it('preserves a throwing onError getter after committing without recipients', () => {
    const original = new SharedMap('number').set('x', 0);
    const first = original.set('x', 1), second = first.set('x', 2);
    const failure = new Error('options getter failed');
    let throwing = true, reads = 0;
    const state = createSharedState(original, {
      get onError() {
        reads++;
        if (throwing) throw failure;
        return undefined;
      },
    });
    cleanup.push(() => state.dispose());

    expect(() => state.publish(first)).toThrow(failure);
    expect(state.current).toBe(first);
    expect(state.version).toBe(1);
    expect(state.closed).toBe(false);
    expect(state.flush()).toBe(1);
    expect(reads).toBe(1);
    throwing = false;
    expect(state.publish(second)).toBe(2);
    expect(reads).toBe(2);
  });

  it('keeps the nonempty subscriber snapshot when callbacks change membership and throw', () => {
    const original = new SharedMap('number').set('x', 0);
    const first = original.set('x', 1), second = first.set('x', 2);
    const failure = new Error('subscriber failed'), errors: Error[] = [], seen: string[] = [];
    const state = createSharedState(original, { onError: error => errors.push(error) });
    cleanup.push(() => state.dispose());
    let stopFirst = () => {}, stopSecond = () => {};
    stopFirst = state.subscribe((_, version) => {
      seen.push(`first:${version}`);
      stopFirst(); stopSecond();
      state.subscribe((_, nextVersion) => seen.push(`late:${nextVersion}`));
      throw failure;
    });
    stopSecond = state.subscribe((_, version) => seen.push(`second:${version}`));

    expect(state.publish(first)).toBe(1);
    expect(seen).toEqual(['first:1', 'second:1']);
    expect(errors).toEqual([failure]);
    expect(state.publish(second)).toBe(2);
    expect(seen).toEqual(['first:1', 'second:1', 'late:2']);
    expect(errors).toEqual([failure]);
  });

  it('keeps an earlier async rejection bound to its handler after a recipient-free publication', async () => {
    const original = new SharedMap('number').set('x', 0);
    const first = original.set('x', 1), second = first.set('x', 2);
    const failure = new Error('async subscriber failed'), firstErrors: Error[] = [], laterErrors: Error[] = [];
    let reads = 0, unsubscribe = () => {};
    const state = createSharedState(original, {
      get onError() { return ++reads === 1 ? error => firstErrors.push(error) : error => laterErrors.push(error); },
    });
    cleanup.push(() => state.dispose());
    unsubscribe = state.subscribe(() => { unsubscribe(); return Promise.reject(failure); });

    expect(state.publish(first)).toBe(1);
    expect(state.publish(second)).toBe(2);
    expect(reads).toBe(2);
    await drain();
    expect(firstErrors).toEqual([failure]);
    expect(laterErrors).toEqual([]);
    expect(state.current).toBe(second);
    expect(state.version).toBe(2);
  });
});
