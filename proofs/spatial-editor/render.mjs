import { COORDINATE_SYSTEM, Deck, OrthographicView } from '@deck.gl/core';
import { PathLayer } from '@deck.gl/layers';

export async function renderer() {
  const canvas = document.querySelector('canvas');
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 is required');
  let loaded, failed, pendingFrame, renderStarted;
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
    controller: false, _animate: true, onLoad: loaded,
    onBeforeRender: () => { renderStarted = performance.now(); },
    onAfterRender: () => {
      if (pendingFrame) {
        gl.finish();
        pendingFrame.resolve({
          beforeScreenDrawMs: renderStarted - pendingFrame.propsSet,
          drawAndFinishMs: performance.now() - renderStarted,
        });
        pendingFrame = undefined;
      }
    },
    onError: cause => { error = cause; failed(cause); pendingFrame?.reject(cause); } });
  await ready;
  let ids = [], starts = new Uint32Array(), positions = new Float64Array(), indexById = new Map();
  return {
    async draw(nextIds, paths, box, dirty, commandStarted) {
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
      const writes = repack ? ids : dirty !== undefined && indexById.has(dirty) ? [dirty] : [];
      for (const id of writes) {
        const path = paths.get(id), offset = starts[indexById.get(id)] * 2;
        if (path instanceof Float64Array) positions.set(path, offset);
        else path.copyToFloat64Array(positions, { offset });
      }
      const packed = performance.now();
      if (writes.length || repack) {
        const data = { length: ids.length, startIndices: starts, attributes: { getPath: { value: positions, size: 2 } } };
        deck.setProps({ layers: [new PathLayer({ id: 'lanes', data, positionFormat: 'XY', _pathType: 'open',
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, getColor: [40, 170, 85], getWidth: 2,
          widthUnits: 'pixels', pickable: true })] });
      }
      deck.setProps({ viewState: { target: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2, 0], zoom: 2.5 } });
      if (error) throw error;
      const propsSet = performance.now();
      const draw = await new Promise((resolve, reject) => { pendingFrame = { propsSet, resolve, reject }; });
      return { commandBeforePackMs: begin - commandStarted, packMs: packed - begin, setPropsMs: propsSet - packed, ...draw,
        uploadBytes: uploadBytes - bytesBefore, uploadCallMs: uploadCallMs - uploadBefore };

    },
    check(idsToCheck, expectedPath, movedY) {
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
    dispose() { deck.finalize(); },
  };
}
