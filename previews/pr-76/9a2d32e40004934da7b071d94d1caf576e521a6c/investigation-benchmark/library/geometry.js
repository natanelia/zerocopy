import {
  arenaOf
} from "./chunk-vzhwgf41.js";
import {
  SharedList2
} from "./chunk-nk9phzb0.js";

// geometry-wasm.ts
function loadGeometryWasm() {
  const text = atob("AGFzbQEAAAABFQNgAAF8YAR/f39/AGAFf39/f38BfwISAQNlbnYGbWVtb3J5AgMCgIAEAwcGAAAAAAECBjEEfAFEAAAAAAAA8P8LfAFEAAAAAAAA8P8LfAFEAAAAAAAA8H8LfAFEAAAAAAAA8H8LB0gHBm1lbW9yeQIACGJib3hNYXhYAAAIYmJveE1heFkAAQhiYm94TWluWAACCGJib3hNaW5ZAAMGYmJveFhZAAQGeHlMZWFmAAUKzwcGBAAjAAsEACMBCwQAIwILBAAjAwvrBQIIfwZ8AkAgA0EBcUUEQCADRQRARAAAAAAAAPD/IQ1EAAAAAAAA8H8hDkQAAAAAAADwfyEPRAAAAAAAAPD/IRAMAgsgA0ECa0FgcSEIIAFFBEBEAAAAAAAA8H8hD0QAAAAAAADw/yEQRAAAAAAAAPD/IQ1EAAAAAAAA8H8hDgNAIAAgAiAGIAhJGyIBIAFBICADIAZrIgQgBEEgTxtBA3RqIgRJBEAgAUEIaiEFA0ACfAJ8IAVBCEcEQCAFQQhrKwAAIgwgBQ0BGkEAKwMADAILQQArAwALIQwgBSsAAAsiESANIA0gEWMbIQ0gDCAQIAwgEGQbIRAgESAOIA4gEWQbIQ4gDCAPIAwgD2MbIQ8gBUEIaiEBIAVBEGohBSABIARJDQALCyAGQSBqIgYgA0kNAAsMAgsgAUEBayEJIAFBAXEhCiABQQVsQR9xIQtEAAAAAAAA8H8hD0QAAAAAAADw/yEQRAAAAAAAAPD/IQ1EAAAAAAAA8H8hDgNAIAIhBAJAIAcgCE8NACAAIQQgASEGIAoEQCAJIQYCfyAHIAt2QQJ0QfwAcSAEaiIEBEAgBCgAAAwBC0EAKAIACyEECyABQQFGDQAgBkEFbCEFA0ACfwJ/IAcgBXZBAnRB/ABxIARqIgRFBEBBACgCAAwBCyAEKAAACyAHIAVBG2p2QQJ0QfwAcWoiBARAIAQoAAAMAQtBACgCAAshBCAFQQprIQUgBkECayIGDQALCyAEQSAgAyAHayIGIAZBIE8bQQN0aiIGIARLBEAgBEEIaiEFA0ACfAJAIAVBCEYEQEEAKwMAIQwMAQsgBUEIaysAACEMIAUNAEEAKwMADAELIAUrAAALIhEgDSANIBFjGyENIAwgECAMIBBkGyEQIBEgDiAOIBFkGyEOIAwgDyAMIA9jGyEPIAVBCGohBCAFQRBqIQUgBCAGSQ0ACwsgAyAHQSBqIgdLDQALDAELAAsgDyQCIA4kAyAQJAAgDSQBC8sBAAJAIAQgA0EBa0FgcU8NACABRQRAIAAPCwJ/IAFBAXFFBEAgASEDIAAMAQsgAUEBayEDAn8gBCABQQVsdkECdEH8AHEgAGoiAARAIAAoAAAMAQtBACgCAAsLIQIgAUEBRg0AIANBBWwhAQNAAn8CfyAEIAF2QQJ0QfwAcSACaiIARQRAQQAoAgAMAQsgACgAAAsgBCABQRtqdkECdEH8AHFqIgAEQCAAKAAADAELQQAoAgALIQIgAUEKayEBIANBAmsiAw0ACwsgAgsAnQEPdGFyZ2V0X2ZlYXR1cmVzCSsHYXRvbWljcysPbXV0YWJsZS1nbG9iYWxzKxNub250cmFwcGluZy1mcHRvaW50KwtidWxrLW1lbW9yeSsIc2lnbi1leHQrD3JlZmVyZW5jZS10eXBlcysKbXVsdGl2YWx1ZSsPYnVsay1tZW1vcnktb3B0KxZjYWxsLWluZGlyZWN0LW92ZXJsb25n");
  const bytes = new Uint8Array(text.length);
  for (let i = 0;i < text.length; i++)
    bytes[i] = text.charCodeAt(i);
  return bytes;
}

// geometry-runtime.ts
var compiled;
var instances = new WeakMap;
function geometryKernel(memory) {
  const cached = instances.get(memory);
  if (cached)
    return cached;
  compiled ??= new WebAssembly.Module(loadGeometryWasm());
  const kernel = new WebAssembly.Instance(compiled, { env: { memory } }).exports;
  instances.set(memory, kernel);
  return kernel;
}
function assertXY(points) {
  if (!(points instanceof SharedList2) || points.type !== "number")
    throw new TypeError("Expected a numeric SharedList");
  if (points.size & 1)
    throw new RangeError("Coordinates must contain complete x/y pairs");
}

// geometry.ts
function bboxXY(points) {
  assertXY(points);
  if (!points.size)
    return [Infinity, Infinity, -Infinity, -Infinity];
  const kernel = geometryKernel(arenaOf(points).memory);
  kernel.bboxXY(points.root, points.depth, points.tail, points.size);
  return [kernel.bboxMinX(), kernel.bboxMinY(), kernel.bboxMaxX(), kernel.bboxMaxY()];
}
export {
  bboxXY
};
