// This entry is used only by one of the four separate mechanism groups.
// No timing group imports this file or restores a previous constructor patch.
import { runWorker } from './worker-runtime.mjs';
const Original=WebAssembly.Instance;
let instances=0;
WebAssembly.Instance=class extends Original {
  constructor(...args) {super(...args);instances++;}
};
await runWorker(()=>instances);
