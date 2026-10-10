// Resolves only after the full JSON line has left the Writable's pending queue.
// This runs outside the timed interval. Pipe completion is not disk durability.
export function writeRow(row, stream = process.stdout) {
  return new Promise((resolve, reject) => {
    let line;
    try { line = JSON.stringify(row) + '\n'; } catch (error) { reject(error); return; }
    const failed = error => { stream.off('error', failed); reject(error); };
    stream.once('error', failed);
    try {
      stream.write(line, error => {
        // Writable may emit its error after invoking this callback. Keep the
        // one-shot listener until that event when the callback reports failure.
        if (error) reject(error);
        else { stream.off('error', failed); resolve(); }
      });
    } catch (error) { failed(error); }
  });
}
