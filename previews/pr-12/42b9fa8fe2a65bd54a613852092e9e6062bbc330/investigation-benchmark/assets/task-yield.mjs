/** Yield to a real task, without the nested setTimeout minimum delay.
 * All data implementations use this same scheduler. Promise.resolve() is not
 * a substitute: it would prevent queued cancellation messages from running.
 */
let channel;
let pending = [], head = 0;
export function yieldToEvents() {
  // Node can drain one MessagePort before servicing another. setImmediate
  // gives its poll phase a turn so cancellation on another port is not starved.
  if (typeof globalThis.setImmediate === 'function') return new Promise(resolve => globalThis.setImmediate(resolve));
  if (typeof MessageChannel === 'undefined') return new Promise(resolve => setTimeout(resolve, 0));
  channel ??= createChannel();
  return new Promise((resolve, reject) => {
    if (head === pending.length) { channel.port1.ref?.(); channel.port2.ref?.(); }
    pending.push(resolve);
    try { channel.port2.postMessage(0); }
    catch (error) {
      pending.pop();
      if (head === pending.length) idle();
      reject(error);
    }
  });
}
function idle() {
  pending = []; head = 0;
  // Node proofs must exit when no work is pending. Browsers have no ref API.
  channel.port1.unref?.(); channel.port2.unref?.();
}
function createChannel() {
  const value = new MessageChannel();
  value.port1.onmessage = () => {
    const resolve = pending[head]; pending[head++] = undefined;
    if (head === pending.length) idle();
    resolve();
  };
  return value;
}
