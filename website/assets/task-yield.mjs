/** Yield to a real task. Every comparison path uses this same scheduler.
 * A timer is a second task source, not an artificial delay. It keeps progress
 * possible when a browser stops delivering local MessagePort tasks in a worker.
 * The first task wins; late messages cannot settle another yield.
 */
let channel, nextId = 0;
const pending = new Map();
export function yieldToEvents() {
  // Node can drain one MessagePort before servicing another. setImmediate
  // gives its poll phase a turn so cancellation on another port is not starved.
  if (typeof globalThis.setImmediate === 'function') return new Promise(resolve => globalThis.setImmediate(resolve));
  if (typeof MessageChannel === 'undefined') return timerYield();
  if (!channel) {
    try { channel = createChannel(); }
    catch { return timerYield(); }
  }
  const id = ++nextId;
  return new Promise(resolve => {
    if (!pending.size) { channel.port1.ref?.(); channel.port2.ref?.(); }
    // MessageChannel avoids nested-timer clamping in the normal path. Keeping
    // an independent timer also covers stalled ports and synchronous send errors.
    const timer = setTimeout(() => finish(id), 0);
    pending.set(id, { resolve, timer });
    try { channel.port2.postMessage(id); }
    catch { /* The already scheduled timer completes this yield as a task. */ }
  });
}
function timerYield() { return new Promise(resolve => setTimeout(resolve, 0)); }
function finish(id) {
  const item = pending.get(id);
  if (!item) return;
  pending.delete(id); clearTimeout(item.timer);
  if (!pending.size) { channel.port1.unref?.(); channel.port2.unref?.(); }
  item.resolve();
}
function createChannel() {
  const value = new MessageChannel();
  try {
    value.port1.onmessage = ({ data }) => finish(data);
    value.port1.start();
    return value;
  } catch (error) {
    value.port1.close(); value.port2.close(); throw error;
  }
}
