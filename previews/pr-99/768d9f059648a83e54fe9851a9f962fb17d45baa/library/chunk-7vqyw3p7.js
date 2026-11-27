// snapshot-listeners.ts
function notifySubscribers(listeners, onError, ...args) {
  if (!listeners.size)
    return;
  for (const listener of [...listeners]) {
    try {
      const result = listener(...args);
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(onError);
      }
    } catch (error) {
      onError(error);
    }
  }
}

export { notifySubscribers };
