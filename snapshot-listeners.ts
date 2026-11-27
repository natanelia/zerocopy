/** Listener failures must not interrupt publication of an already installed snapshot. */
export function notifySubscribers<Args extends unknown[]>(
  listeners: ReadonlySet<(...args: Args) => void>, onError: (error: unknown) => void, ...args: Args
): void {
  if (!listeners.size) return;
  for (const listener of [...listeners]) {
    try {
      const result = listener(...args) as unknown;
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        Promise.resolve(result).catch(onError);
      }
    } catch (error) { onError(error); }
  }
}
