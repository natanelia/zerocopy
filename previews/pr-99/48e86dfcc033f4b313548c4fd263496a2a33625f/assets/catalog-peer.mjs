import { Peer as BasePeer } from './feature-peer.mjs';
export { listen } from './feature-peer.mjs';

/** Inherit the isolated document's policy when loading a catalog owner. */
export class Peer extends BasePeer {
  constructor(url) {
    // Nested readers already use BasePeer's inherited-isolation bootstrap.
    if (typeof document === 'undefined') { super(url); return; }
    const bootstrap = URL.createObjectURL(new Blob([`import ${JSON.stringify(url.href)};`], { type: 'text/javascript' }));
    try { super(new URL(bootstrap)); }
    catch (error) { URL.revokeObjectURL(bootstrap); throw error; }
    this.ownerBootstrap = bootstrap;
  }
  close(error) {
    super.close(error);
    if (this.ownerBootstrap) {
      URL.revokeObjectURL(this.ownerBootstrap);
      this.ownerBootstrap = undefined;
    }
  }
}
