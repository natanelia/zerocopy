import { COORDINATE_SYSTEM, Deck, OrthographicView } from '@deck.gl/core';
import { PathLayer } from '@deck.gl/layers';

// WebGL PathLayer reads the previous, current and next XY positions from one
// buffer. The pinned layer uses one leading and two trailing padding vertices.
const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
function pathBuffer(device) {
  let gpu, retired, packed = new Float32Array();
  return {
    pack(positions, start, end) {
      if (packed.length < positions.length * 2) packed = new Float32Array(positions.length * 2);
      for (let i = start; i < end; i++) {
        const x = positions[i * 2], y = positions[i * 2 + 1];
        packed[i * 4] = x;
        packed[i * 4 + 1] = y;
        packed[i * 4 + 2] = x - packed[i * 4];
        packed[i * 4 + 3] = y - packed[i * 4 + 1];
      }
    },
    write(positions, start, end) {
      const capacity = (positions.length / 2 + 3) * stride;
      if (!gpu || gpu.byteLength < capacity) {
        retired = gpu;
        gpu = device.createBuffer({ byteLength: capacity });
      }
      if (end > start) gpu.write(packed.subarray(start * 4, end * 4), (start + 1) * stride);
    },
    attribute(value) {
      // The Float64 CPU value signals deck.gl to bind both high and low parts.
      return { buffer: gpu, value, size: 2, stride, type: 'float32' };
    },
    check(positions) {
      if (!positions.length) return;
      const bytes = gpu.readSyncWebGL(stride, positions.byteLength);
      const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      for (let i = 0; i < positions.length; i++) {
        const index = Math.floor(i / 2) * 4 + i % 2;
        const high = Math.fround(positions[i]);
        if (values[index] !== high || values[index + 2] !== Math.fround(positions[i] - high)) {
          throw new Error('GPU position differs from the visible snapshot at coordinate ' + i);
        }
      }
    },
    afterDraw() { retired?.destroy(); retired = undefined; },
    dispose() { retired?.destroy(); gpu?.destroy(); },
  };
}

export async function renderer(graphicsMode, uploads) {
  const canvas = document.querySelector('canvas');
  const gl = canvas.getContext('webgl2', {
    preserveDrawingBuffer: true, failIfMajorPerformanceCaveat: graphicsMode === 'hardware',
  });
  if (!gl) throw new Error('WebGL2 unavailable for requested renderer: ' + graphicsMode);
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  if (!info) throw new Error('WebGL renderer identification is required for this replay');
  const graphics = { mode: graphicsMode, vendor: gl.getParameter(info.UNMASKED_VENDOR_WEBGL),
    renderer: gl.getParameter(info.UNMASKED_RENDERER_WEBGL) };
  if (graphicsMode === 'swiftshader' && !/swiftshader/i.test(graphics.renderer)) {
    throw new Error('Expected SwiftShader, got ' + graphics.renderer);
  }
  if (graphicsMode === 'hardware' && (!graphics.renderer ||
    /swiftshader|llvmpipe|softpipe|software|lavapipe|basic render|\bwarp\b/i.test(graphics.renderer))) {
    throw new Error('Hardware mode rejected WebGL renderer: ' + graphics.renderer);
  }
  let loaded, failed, pendingFrame, renderStarted, device;
  let uploadBytes = 0, uploadCallMs = 0;
  // Count WebGL client buffer uploads on this context. Allocating GPU storage
  // by size alone transfers no client bytes. Call time excludes GPU completion.
  for (const [method, dataArg] of [['bufferData', 1], ['bufferSubData', 2]]) {
    const original = gl[method];
    gl[method] = function (...args) {
      const data = args[dataArg], start = performance.now();
      const result = original.apply(this, args);
      if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) {
        const elementSize = data.BYTES_PER_ELEMENT ?? 1;
        const offset = args[3] ?? 0, count = args[4];
        uploadBytes += count ? count * elementSize : data.byteLength - offset * elementSize;
        uploadCallMs += performance.now() - start;
      }
      return result;
    };
  }
  const ready = new Promise((resolve, reject) => { loaded = resolve; failed = reject; });
  let error;
  const deck = new Deck({ canvas, gl, width: 320, height: 200, useDevicePixels: false,
    views: new OrthographicView({ flipY: false }), initialViewState: { target: [16, 7, 0], zoom: 2.5 },
    // The pinned deck.gl forwards this provider to luma.gl's animation loop.
    // Timestamp the actual callback that draws the update on the native rAF cadence.
    animationFrameProvider: {
      requestAnimationFrame: callback => window.requestAnimationFrame(time => {
        if (pendingFrame) pendingFrame.callbackStarted = performance.now();
        callback(time);
      }),
      cancelAnimationFrame: handle => window.cancelAnimationFrame(handle),
    },
    controller: false, _animate: true, onLoad: loaded, onDeviceInitialized: value => { device = value; },
    onBeforeRender: () => { renderStarted = performance.now(); },
    onAfterRender: () => {
      if (pendingFrame) {
        const { propsSet, callbackStarted } = pendingFrame;
        if (!(propsSet <= callbackStarted && callbackStarted <= renderStarted)) {
          pendingFrame.reject(new Error('Screen draw did not follow the measured animation callback'));
          pendingFrame = undefined;
          return;
        }
        gl.finish();
        pendingFrame.resolve({
          waitForAnimationFrameMs: callbackStarted - propsSet,
          prepareScreenDrawMs: renderStarted - callbackStarted,
          drawAndFinishMs: performance.now() - renderStarted,
        });
        pendingFrame = undefined;
      }
    },
    onError: cause => { error = cause; failed(cause); pendingFrame?.reject(cause); } });
  await ready;
  const binary = uploads === 'range' ? pathBuffer(device) : null;
  let ids = [], starts = new Uint32Array(), positions = new Float64Array(), indexById = new Map();
  return {
    graphics,
    async draw(nextIds, paths, box, patch, commandStarted) {
      const begin = performance.now(), bytesBefore = uploadBytes, uploadBefore = uploadCallMs;
      const length = path => path.length ?? path.size;
      const repack = nextIds.length !== ids.length || nextIds.some((id, i) =>
        id !== ids[i] || length(paths.get(id)) !== 2 * (starts[i + 1] - starts[i]));
      if (repack) {
        ids = nextIds.slice();
        starts = new Uint32Array(ids.length + 1);
        indexById = new Map(ids.map((id, i) => [id, i]));
        for (let i = 0; i < ids.length; i++) starts[i + 1] = starts[i] + length(paths.get(ids[i])) / 2;
        positions = new Float64Array(starts.at(-1) * 2);
      }
      const writes = repack ? ids : patch && indexById.has(patch.id) ? [patch.id] : [];
      let packedBytes = 0, startVertex = 0, endVertex = 0;
      for (const id of writes) {
        const path = paths.get(id), offset = starts[indexById.get(id)] * 2;
        const oneVertex = binary && !repack && patch.axis !== undefined;
        const start = oneVertex ? patch.axis - patch.axis % 2 : 0;
        const end = oneVertex ? start + 2 : length(path);
        if (path instanceof Float64Array) positions.set(oneVertex ? path.subarray(start, end) : path, offset + start);
        else path.copyToFloat64Array(positions, { start, end, offset: offset + start });
        packedBytes += (end - start) * 8;
        startVertex = repack ? 0 : (offset + start) / 2;
        endVertex = (offset + end) / 2;
      }
      binary?.pack(positions, startVertex, endVertex);
      const packed = performance.now();
      if (binary && (writes.length || repack)) binary.write(positions, startVertex, endVertex);
      const positionUploadBytes = binary ? uploadBytes - bytesBefore : undefined;
      if (repack || (!binary && writes.length)) {
        const getPath = binary ? binary.attribute(positions) : { value: positions, size: 2 };
        const data = { length: ids.length, startIndices: starts, attributes: { getPath } };
        deck.setProps({ layers: [new PathLayer({ id: 'lanes', data, positionFormat: 'XY', _pathType: 'open',
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, getColor: [40, 170, 85], getWidth: 2,
          widthUnits: 'pixels', pickable: true })] });
      }
      deck.setProps({ viewState: { target: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2, 0], zoom: 2.5 } });
      if (error) throw error;
      const propsSet = performance.now();
      const draw = await new Promise((resolve, reject) => { pendingFrame = { propsSet, resolve, reject }; });
      binary?.afterDraw();
      return { commandBeforePackMs: begin - commandStarted, packMs: packed - begin, setPropsMs: propsSet - packed, ...draw,
        packedBytes, positionUploadBytes, uploadBytes: uploadBytes - bytesBefore, uploadCallMs: uploadCallMs - uploadBefore };

    },
    check(idsToCheck, expectedPath, movedY) {
      binary?.check(positions);
      for (const id of idsToCheck) {
        const i = indexById.get(id);
        const actual = positions.subarray(2 * starts[i], 2 * starts[i + 1]);
        const expected = expectedPath(id);
        if (actual.length !== expected.length || actual.some((value, j) => value !== expected[j])) {
          throw new Error('Binary path offsets or coordinates disagree for ' + id);
        }
      }
      // Exercise deck picking and verify that binary row indices resolve to stable lane IDs.
      const picks = deck.pickObjects({ x: 0, y: 0, width: 320, height: 200 });
      if (ids.length && !picks.length) throw new Error('Rendered viewport contains no pickable lanes');
      for (const pick of picks) if (!indexById.has(ids[pick.index])) throw new Error('Unmapped picking index');
      if (movedY !== undefined) {
        const [x, y] = deck.getViewports()[0].project([8, 6, 0]);
        const hits = deck.pickObjects({ x: Math.floor(x) - 1, y: Math.floor(y) - 1, width: 3, height: 3 });
        if (hits.some(pick => ids[pick.index] === '1') !== (movedY === 8)) {
          throw new Error('GPU picking geometry did not follow the vertex drag or undo');
        }
      }
      // A fixed point on an untouched lane also checks the GPU row-to-ID mapping
      // after paths with different vertex counts have been inserted or removed.
      const stableId = ids.includes('2') ? '2' : '7';
      if (indexById.has(stableId)) {
        const path = expectedPath(stableId);
        const [x, y] = deck.getViewports()[0].project([path.at(-2) - 0.1, path.at(-1), 0]);
        const near = deck.pickObjects({ x: Math.floor(x) - 2, y: Math.floor(y) - 2, width: 5, height: 5 });
        if (!near.some(pick => ids[pick.index] === stableId)) throw new Error('Wrong lane picked at known XY');
      }
    },
    dispose() { try { deck.finalize(); } finally { binary?.dispose(); } },
  };
}
