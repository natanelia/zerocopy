import {
  arenaOf
} from "./chunk-sk2m3h91.js";
import {
  SharedList2
} from "./chunk-g1864cm0.js";

// geometry-wasm.ts
function loadGeometryWasm() {
  const text = atob("AGFzbQEAAAABFQNgAAF8YAR/f39/AGAFf39/f38BfwISAQNlbnYGbWVtb3J5AgMCgIAEAwcGAAAAAAECBjEEfAFEAAAAAAAA8P8LfAFEAAAAAAAA8P8LfAFEAAAAAAAA8H8LfAFEAAAAAAAA8H8LB0gHBm1lbW9yeQIACGJib3hNYXhYAAAIYmJveE1heFkAAQhiYm94TWluWAACCGJib3hNaW5ZAAMGYmJveFhZAAQGeHlMZWFmAAUK0wYGBAAjAAsEACMBCwQAIwILBAAjAwvvBAIIfwZ8AkAgA0EBcUUEQCADRQRARAAAAAAAAPD/IQ1EAAAAAAAA8H8hDkQAAAAAAADwfyEPRAAAAAAAAPD/IRAMAgsgAUEBayEIIAFBAXEhCSABQQVsQR9xIQogA0ECa0FgcSELRAAAAAAAAPB/IQ9EAAAAAAAA8P8hEEQAAAAAAADw/yENRAAAAAAAAPB/IQ4DQCACIAAgBiALTyIFGyEEAkAgBQ0AIAFFDQAgACEEIAEhBSAJBEACfyAGIAp2QQJ0QfwAcSAEaiIFBEAgBSgAAAwBC0EAKAIACyEEIAghBQsgAUEBRg0AIAVBBWwhBwNAAn8CfyAGIAd2QQJ0QfwAcSAEaiIERQRAQQAoAgAMAQsgBCgAAAsgBiAHQRtqdkECdEH8AHFqIgQEQCAEKAAADAELQQAoAgALIQQgB0EKayEHIAVBAmsiBQ0ACwsgBEEgIAMgBmsiBSAFQSBPG0EDdGohBQJAIARBB3EEQCAEIAVPDQEgBEEIaiEEA0ACfAJAIARBCEYEQEEAKwMAIQwMAQsgBEEIaysAACEMIAQNAEEAKwMADAELIAQrAAALIhEgDSANIBFjGyENIAwgECAMIBBkGyEQIBEgDiAOIBFkGyEOIAwgDyAMIA9jGyEPIARBCGohByAEQRBqIQQgBSAHSw0ACwwBCyAEIAVPDQADQCAEQQhqKwMAIgwgDSAMIA1kGyENIAwgDiAMIA5jGyEOIAQrAwAiDCAQIAwgEGQbIRAgDCAPIAwgD2MbIQ8gBEEQaiIEIAVJDQALCyADIAZBIGoiBksNAAsMAQsACyAPJAIgDiQDIBAkACANJAELywEAAkAgBCADQQFrQWBxTw0AIAFFBEAgAA8LAn8gAUEBcUUEQCABIQMgAAwBCyABQQFrIQMCfyAEIAFBBWx2QQJ0QfwAcSAAaiIABEAgACgAAAwBC0EAKAIACwshAiABQQFGDQAgA0EFbCEBA0ACfwJ/IAQgAXZBAnRB/ABxIAJqIgBFBEBBACgCAAwBCyAAKAAACyAEIAFBG2p2QQJ0QfwAcWoiAARAIAAoAAAMAQtBACgCAAshAiABQQprIQEgA0ECayIDDQALCyACCwCdAQ90YXJnZXRfZmVhdHVyZXMJKwdhdG9taWNzKw9tdXRhYmxlLWdsb2JhbHMrE25vbnRyYXBwaW5nLWZwdG9pbnQrC2J1bGstbWVtb3J5KwhzaWduLWV4dCsPcmVmZXJlbmNlLXR5cGVzKwptdWx0aXZhbHVlKw9idWxrLW1lbW9yeS1vcHQrFmNhbGwtaW5kaXJlY3Qtb3Zlcmxvbmc=");
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
