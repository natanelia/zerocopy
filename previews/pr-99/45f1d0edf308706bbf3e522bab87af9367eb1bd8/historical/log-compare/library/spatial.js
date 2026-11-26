import {
  json2
} from "./chunk-vb4t84x1.js";
import {
  SharedMap2
} from "./chunk-g5y5pv5w.js";
import {
  checkBounds
} from "./chunk-z3dbw0j2.js";

// node_modules/flatbush/index.js
var ARRAY_TYPES = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array];
var VERSION = 3;

class Flatbush {
  static from(data, byteOffset = 0) {
    if (byteOffset % 8 !== 0) {
      throw new Error("byteOffset must be 8-byte aligned.");
    }
    if (!data || data.byteLength === undefined || "buffer" in data) {
      throw new Error("Data must be an instance of ArrayBuffer or SharedArrayBuffer.");
    }
    const [magic, versionAndType] = new Uint8Array(data, byteOffset + 0, 2);
    if (magic !== 251) {
      throw new Error("Data does not appear to be in a Flatbush format.");
    }
    const version = versionAndType >> 4;
    if (version !== VERSION) {
      throw new Error(`Got v${version} data when expected v${VERSION}.`);
    }
    const ArrayType = ARRAY_TYPES[versionAndType & 15];
    if (!ArrayType) {
      throw new Error("Unrecognized array type.");
    }
    const [nodeSize] = new Uint16Array(data, byteOffset + 2, 1);
    const [numItems] = new Uint32Array(data, byteOffset + 4, 1);
    return new Flatbush(numItems, nodeSize, ArrayType, undefined, data, byteOffset);
  }
  constructor(numItems, nodeSize = 16, ArrayType = Float64Array, ArrayBufferType = ArrayBuffer, data, byteOffset = 0) {
    if (numItems === undefined)
      throw new Error("Missing required argument: numItems.");
    if (!Number.isInteger(+numItems) || numItems <= 0)
      throw new Error(`Unexpected numItems value: ${numItems}.`);
    const arrayTypeIndex = ARRAY_TYPES.indexOf(ArrayType);
    if (arrayTypeIndex < 0)
      throw new Error(`Unexpected typed array class: ${ArrayType?.name}.`);
    this.numItems = +numItems;
    this.nodeSize = Math.min(Math.max(Math.floor(nodeSize) || 2, 2), 65535);
    this.byteOffset = byteOffset;
    let n = this.numItems;
    let numNodes = n;
    this._levelBounds = [n * 4];
    do {
      n = Math.ceil(n / this.nodeSize);
      numNodes += n;
      this._levelBounds.push(numNodes * 4);
    } while (n !== 1);
    this.ArrayType = ArrayType;
    this.IndexArrayType = numNodes < 16384 ? Uint16Array : Uint32Array;
    const nodesByteSize = numNodes * 4 * ArrayType.BYTES_PER_ELEMENT;
    const BoxCtor = ArrayType;
    const IdxCtor = this.IndexArrayType;
    if (data) {
      this.data = data;
      this._boxes = new BoxCtor(data, byteOffset + 8, numNodes * 4);
      this._indices = new IdxCtor(data, byteOffset + 8 + nodesByteSize, numNodes);
      this._pos = numNodes * 4;
      this.minX = this._boxes[this._pos - 4];
      this.minY = this._boxes[this._pos - 3];
      this.maxX = this._boxes[this._pos - 2];
      this.maxY = this._boxes[this._pos - 1];
      if (hasNaN(this._boxes, this._pos - 4))
        throw new Error("Data has items with NaN coordinates.");
    } else {
      const data = this.data = new ArrayBufferType(8 + nodesByteSize + numNodes * this.IndexArrayType.BYTES_PER_ELEMENT);
      this._boxes = new BoxCtor(data, 8, numNodes * 4);
      this._indices = new IdxCtor(data, 8 + nodesByteSize, numNodes);
      this._pos = 0;
      this.minX = Infinity;
      this.minY = Infinity;
      this.maxX = -Infinity;
      this.maxY = -Infinity;
      new Uint8Array(data, 0, 2).set([251, (VERSION << 4) + arrayTypeIndex]);
      new Uint16Array(data, 2, 1)[0] = this.nodeSize;
      new Uint32Array(data, 4, 1)[0] = this.numItems;
    }
    this._heapIds = new Uint32Array(64);
    this._heapDists = new Float64Array(64);
    this._heapSize = 0;
  }
  trim() {
    const numAdded = this._pos >> 2;
    if (numAdded >= this.numItems)
      return;
    const ArrayBufferType = this.data.constructor;
    const trimmed = new Flatbush(numAdded, this.nodeSize, this.ArrayType, ArrayBufferType);
    trimmed._boxes.set(this._boxes.subarray(0, numAdded * 4));
    trimmed._indices.set(this._indices.subarray(0, numAdded));
    this.numItems = numAdded;
    this.data = trimmed.data;
    this._boxes = trimmed._boxes;
    this._indices = trimmed._indices;
    this._levelBounds = trimmed._levelBounds;
    this.IndexArrayType = trimmed.IndexArrayType;
    this.byteOffset = 0;
  }
  add(minX, minY, maxX = minX, maxY = minY) {
    const pos = this._pos;
    const index = pos >> 2;
    const boxes = this._boxes;
    this._indices[index] = index;
    boxes[pos] = minX;
    boxes[pos + 1] = minY;
    boxes[pos + 2] = maxX;
    boxes[pos + 3] = maxY;
    this._pos = pos + 4;
    if (minX < this.minX)
      this.minX = minX;
    if (minY < this.minY)
      this.minY = minY;
    if (maxX > this.maxX)
      this.maxX = maxX;
    if (maxY > this.maxY)
      this.maxY = maxY;
    return index;
  }
  finish() {
    if (this._pos >> 2 !== this.numItems) {
      throw new Error(`Added ${this._pos >> 2} items when expected ${this.numItems}.`);
    }
    const { _boxes: boxes, numItems, minX, minY, nodeSize, _indices: indices, _levelBounds: levelBounds } = this;
    if (numItems > nodeSize) {
      const width = this.maxX - minX || 1;
      const height = this.maxY - minY || 1;
      const useRadix = numItems >= 1024;
      const hilbertValues = new Int32Array(useRadix ? numItems * 2 : numItems);
      const hilbertMax = (1 << 16) - 1;
      const sx = hilbertMax / width;
      const sy = hilbertMax / height;
      for (let i = 0, pos = 0;i < numItems; i++) {
        const itemMinX = boxes[pos++];
        const itemMinY = boxes[pos++];
        const itemMaxX = boxes[pos++];
        const itemMaxY = boxes[pos++];
        const x = sx * ((itemMinX + itemMaxX) / 2 - minX) | 0;
        const y = sy * ((itemMinY + itemMaxY) / 2 - minY) | 0;
        hilbertValues[i] = hilbert(x, y);
      }
      if (useRadix) {
        radixSort(hilbertValues, boxes, indices, numItems, this.ArrayType);
      } else {
        sort(hilbertValues, boxes, indices, 0, numItems - 1, nodeSize);
      }
    }
    let pos = numItems * 4;
    for (let i = 0, readPos = 0;i < levelBounds.length - 1; i++) {
      const end = levelBounds[i];
      while (readPos < end) {
        const nodeIndex = readPos;
        let nodeMinX = boxes[readPos++];
        let nodeMinY = boxes[readPos++];
        let nodeMaxX = boxes[readPos++];
        let nodeMaxY = boxes[readPos++];
        for (let j = 1;j < nodeSize && readPos < end; j++) {
          nodeMinX = Math.min(nodeMinX, boxes[readPos++]);
          nodeMinY = Math.min(nodeMinY, boxes[readPos++]);
          nodeMaxX = Math.max(nodeMaxX, boxes[readPos++]);
          nodeMaxY = Math.max(nodeMaxY, boxes[readPos++]);
        }
        indices[pos >> 2] = nodeIndex;
        boxes[pos++] = nodeMinX;
        boxes[pos++] = nodeMinY;
        boxes[pos++] = nodeMaxX;
        boxes[pos++] = nodeMaxY;
      }
    }
    if (hasNaN(boxes, pos - 4))
      throw new Error("Data has items with NaN coordinates.");
    this._pos = pos;
  }
  search(minX, minY, maxX, maxY, filterFn) {
    if (this._pos !== this._boxes.length) {
      throw new Error("Data not yet indexed - call index.finish().");
    }
    const { _boxes: boxes, _levelBounds: levelBounds, _indices: indices, nodeSize } = this;
    const numItems4 = this.numItems * 4;
    let nodeIndex = boxes.length - 4;
    let level = levelBounds.length - 1;
    const q = [];
    const results = [];
    let contained = false;
    while (nodeIndex !== undefined) {
      const end = Math.min(nodeIndex + nodeSize * 4, levelBounds[level]);
      const isNode = nodeIndex >= numItems4;
      if (contained) {
        this._collectContained(nodeIndex, end, level, numItems4, results, filterFn);
      } else {
        for (let pos = nodeIndex;pos < end; pos += 4) {
          const x0 = boxes[pos];
          if (maxX < x0)
            continue;
          const y0 = boxes[pos + 1];
          if (maxY < y0)
            continue;
          const x1 = boxes[pos + 2];
          if (minX > x1)
            continue;
          const y1 = boxes[pos + 3];
          if (minY > y1)
            continue;
          const index = indices[pos >> 2] | 0;
          if (isNode) {
            const c = +(minX <= x0 && minY <= y0 && maxX >= x1 && maxY >= y1);
            q.push(index | c, level - 1);
          } else if (filterFn === undefined || filterFn(index, x0, y0, x1, y1)) {
            results.push(index);
          }
        }
      }
      level = q.pop();
      nodeIndex = q.pop();
      if (nodeIndex !== undefined) {
        contained = (nodeIndex & 1) === 1;
        nodeIndex &= ~1;
      }
    }
    return results;
  }
  _collectContained(nodeIndex, end, level, numItems4, results, filterFn) {
    const boxes = this._boxes;
    const indices = this._indices;
    let pos = nodeIndex;
    for (let l = level;l > 0; l--)
      pos = indices[pos >> 2];
    const leafEnd = Math.min(pos + (end - nodeIndex) * this.nodeSize ** level, numItems4);
    if (filterFn === undefined) {
      for (;pos < leafEnd; pos += 4)
        results.push(indices[pos >> 2] | 0);
    } else {
      for (;pos < leafEnd; pos += 4) {
        const index = indices[pos >> 2] | 0;
        if (filterFn(index, boxes[pos], boxes[pos + 1], boxes[pos + 2], boxes[pos + 3]))
          results.push(index);
      }
    }
  }
  collides(minX, minY, maxX, maxY, filterFn) {
    if (this._pos !== this._boxes.length) {
      throw new Error("Data not yet indexed - call index.finish().");
    }
    const { _boxes: boxes, _levelBounds: levelBounds, _indices: indices, nodeSize } = this;
    const numItems4 = this.numItems * 4;
    let nodeIndex = boxes.length - 4;
    let level = levelBounds.length - 1;
    const q = [];
    while (nodeIndex !== undefined) {
      const end = Math.min(nodeIndex + nodeSize * 4, levelBounds[level]);
      const isNode = nodeIndex >= numItems4;
      for (let pos = nodeIndex;pos < end; pos += 4) {
        const x0 = boxes[pos];
        if (maxX < x0)
          continue;
        const y0 = boxes[pos + 1];
        if (maxY < y0)
          continue;
        const x1 = boxes[pos + 2];
        if (minX > x1)
          continue;
        const y1 = boxes[pos + 3];
        if (minY > y1)
          continue;
        const index = indices[pos >> 2] | 0;
        if (isNode) {
          if (filterFn === undefined && minX <= x0 && minY <= y0 && maxX >= x1 && maxY >= y1)
            return true;
          q.push(index, level - 1);
        } else if (filterFn === undefined || filterFn(index, x0, y0, x1, y1)) {
          return true;
        }
      }
      level = q.pop();
      nodeIndex = q.pop();
    }
    return false;
  }
  neighbors(x, y, maxResults = Infinity, maxDistance = Infinity, filterFn) {
    if (this._pos !== this._boxes.length) {
      throw new Error("Data not yet indexed - call index.finish().");
    }
    if (maxResults === 0 || isNaN(x) || isNaN(y))
      return [];
    const { _boxes: boxes, _levelBounds: levelBounds, _indices: indices, nodeSize } = this;
    const numItems4 = this.numItems * 4;
    const nodeSize4 = nodeSize * 4;
    const results = [];
    const maxDistSquared = maxDistance * maxDistance;
    const trackNearest = maxResults === 1;
    let bound = maxDistSquared;
    let nearest = -1;
    this._heapSize = 0;
    this._push(boxes.length - 4 << 1, 0);
    while (this._heapSize) {
      if (trackNearest && nearest !== -1 && this._heapDists[0] >= bound)
        break;
      const top = this._heapIds[0];
      this._pop();
      if (top & 1) {
        results.push(top >>> 1);
        if (results.length === maxResults)
          break;
        continue;
      }
      const nodeIndex = top >>> 1;
      const isLeafLevel = nodeIndex < numItems4;
      const end = Math.min(nodeIndex + nodeSize4, upperBound(nodeIndex, levelBounds));
      for (let pos = nodeIndex;pos < end; pos += 4) {
        const minX = boxes[pos];
        const minY = boxes[pos + 1];
        const maxX = boxes[pos + 2];
        const maxY = boxes[pos + 3];
        const dx = Math.max(Math.max(minX - x, x - maxX), 0);
        const dy = Math.max(Math.max(minY - y, y - maxY), 0);
        const dist = dx * dx + dy * dy;
        if (dist > bound)
          continue;
        const childIndex = indices[pos >> 2] | 0;
        if (isLeafLevel) {
          if (filterFn === undefined || filterFn(childIndex)) {
            if (trackNearest) {
              nearest = childIndex;
              bound = dist;
            } else {
              this._push(childIndex << 1 | 1, dist);
            }
          }
        } else {
          this._push(childIndex << 1, dist);
        }
      }
    }
    if (nearest !== -1)
      results.push(nearest);
    return results;
  }
  _push(id, dist) {
    let pos = this._heapSize++;
    if (pos === this._heapIds.length) {
      const ids = new Uint32Array(pos * 2), dists = new Float64Array(pos * 2);
      ids.set(this._heapIds);
      dists.set(this._heapDists);
      this._heapIds = ids;
      this._heapDists = dists;
    }
    const ids = this._heapIds, dists = this._heapDists;
    while (pos > 0) {
      const parent = pos - 1 >> 1;
      const d = dists[parent];
      if (dist >= d)
        break;
      ids[pos] = ids[parent];
      dists[pos] = d;
      pos = parent;
    }
    ids[pos] = id;
    dists[pos] = dist;
  }
  _pop() {
    const ids = this._heapIds, dists = this._heapDists, last = --this._heapSize;
    if (last === 0)
      return;
    const id = ids[last], dist = dists[last], half = last >> 1;
    let pos = 0;
    while (pos < half) {
      const left = (pos << 1) + 1;
      const child = left + (+(left + 1 < last) & +(dists[left + 1] < dists[left]));
      if (dists[child] >= dist)
        break;
      ids[pos] = ids[child];
      dists[pos] = dists[child];
      pos = child;
    }
    ids[pos] = id;
    dists[pos] = dist;
  }
}
function hasNaN(boxes, pos) {
  return isNaN(boxes[pos]) || isNaN(boxes[pos + 1]) || isNaN(boxes[pos + 2]) || isNaN(boxes[pos + 3]);
}
function upperBound(value, arr) {
  let i = 0;
  let j = arr.length - 1;
  while (i < j) {
    const m = i + j >> 1;
    if (arr[m] > value) {
      j = m;
    } else {
      i = m + 1;
    }
  }
  return arr[i];
}
var radixCounts;
function radixSort(values, boxes, indices, n, ArrayType) {
  if (!radixCounts)
    radixCounts = new Uint32Array(5120);
  const counts = radixCounts.fill(0);
  const ids = new Uint32Array(values.buffer, 4 * n, n);
  for (let i = 0;i < n; i++) {
    const k = values[i];
    counts[k & 2047]++;
    counts[2048 + (k >> 11 & 2047)]++;
    counts[4096 + (k >>> 22 ^ 512)]++;
  }
  for (let i = 0, lo = 0, mid = 0, hi = 0;i < 2048; i++) {
    const c = counts[i];
    counts[i] = lo;
    lo += c;
    const d = counts[2048 + i];
    counts[2048 + i] = mid;
    mid += d;
    if (i < 1024) {
      const e = counts[4096 + i];
      counts[4096 + i] = hi;
      hi += e;
    }
  }
  for (let i = 0;i < n; i++)
    indices[counts[values[i] & 2047]++] = i;
  for (let i = 0;i < n; i++) {
    const id = indices[i];
    ids[counts[2048 + (values[id] >> 11 & 2047)]++] = id;
  }
  for (let i = 0;i < n; i++) {
    const id = ids[i];
    indices[counts[4096 + (values[id] >>> 22 ^ 512)]++] = id;
  }
  const col = new ArrayType(values.buffer, 0, n);
  for (let c = 0;c < 4; c++) {
    for (let i = 0, k = c;i < n; i++, k += 4)
      col[i] = boxes[k];
    for (let i = 0, k = c;i < n; i++, k += 4)
      boxes[k] = col[indices[i]];
  }
}
function sort(values, boxes, indices, left, right, nodeSize) {
  const stack = [left, right];
  while (stack.length) {
    const r = stack.pop() || 0;
    const l = stack.pop() || 0;
    if (r - l <= nodeSize && Math.floor(l / nodeSize) >= Math.floor(r / nodeSize))
      continue;
    const a = values[l];
    const b = values[l + r >> 1];
    const c = values[r];
    const pivot = a > b !== a > c ? a : b < a !== b < c ? b : c;
    let i = l - 1;
    let j = r + 1;
    while (true) {
      do
        i++;
      while (values[i] < pivot);
      do
        j--;
      while (values[j] > pivot);
      if (i >= j)
        break;
      swap(values, boxes, indices, i, j);
    }
    stack.push(l, j, j + 1, r);
  }
}
function swap(values, boxes, indices, i, j) {
  const temp = values[i];
  values[i] = values[j];
  values[j] = temp;
  const k = 4 * i;
  const m = 4 * j;
  const a = boxes[k];
  const b = boxes[k + 1];
  const c = boxes[k + 2];
  const d = boxes[k + 3];
  boxes[k] = boxes[m];
  boxes[k + 1] = boxes[m + 1];
  boxes[k + 2] = boxes[m + 2];
  boxes[k + 3] = boxes[m + 3];
  boxes[m] = a;
  boxes[m + 1] = b;
  boxes[m + 2] = c;
  boxes[m + 3] = d;
  const e = indices[i];
  indices[i] = indices[j];
  indices[j] = e;
}
function hilbert(x, y) {
  let a = x ^ y;
  let b = 65535 ^ a;
  let c = 65535 ^ (x | y);
  let d = x & (y ^ 65535);
  let A = a | b >> 1;
  let B = a >> 1 ^ a;
  let C = c ^ (c >> 1 ^ b & d >> 1);
  let D = d ^ (a & c >> 1 ^ d >> 1);
  a = A & A >> 2 ^ B & B >> 2;
  b = A & B >> 2 ^ B & (A ^ B) >> 2;
  c = C ^ (A & C >> 2 ^ B & D >> 2);
  d = D ^ (B & C >> 2 ^ (A ^ B) & D >> 2);
  A = a & a >> 4 ^ b & b >> 4;
  B = a & b >> 4 ^ b & (a ^ b) >> 4;
  C = c ^ (a & c >> 4 ^ b & d >> 4);
  D = d ^ (b & c >> 4 ^ (a ^ b) & d >> 4);
  c = C ^ (A & C >> 8 ^ B & D >> 8);
  d = D ^ (B & C >> 8 ^ (A ^ B) & D >> 8);
  c ^= c >> 1;
  d ^= d >> 1;
  a = x ^ y;
  b = d | 65535 ^ (a | c);
  a = (a | a << 8) & 16711935;
  a = (a | a << 4) & 252645135;
  a = (a | a << 2) & 858993459;
  a = (a | a << 1) & 1431655765;
  b = (b | b << 8) & 16711935;
  b = (b | b << 4) & 252645135;
  b = (b | b << 2) & 858993459;
  b = (b | b << 1) & 1431655765;
  return ((b << 1 | a) >>> 0) - 2147483648;
}

// spatial.ts
function checkRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new RangeError("Expected a nonnegative safe spatial revision");
}
function checkId(id) {
  if (!Number.isInteger(id) || id < 0 || id > 4294967295)
    throw new RangeError("Expected a uint32 feature ID");
}
var trees = new WeakMap;
function finishIndex(tree, ids, revision) {
  tree?.finish();
  const base = Object.freeze({ format: 1, revision, ids, buffer: tree ? tree.data : null });
  if (tree)
    trees.set(base, tree);
  return base;
}
function buildSpatialIndex(features, revision = 0) {
  checkRevision(revision);
  const ids = new Uint32Array(new SharedArrayBuffer(features.length * 4));
  const tree = features.length ? new Flatbush(features.length, 16, Float64Array, SharedArrayBuffer) : undefined;
  const seen = new Set;
  for (const { id, bounds } of features) {
    checkId(id);
    checkBounds(bounds, true);
    if (seen.has(id))
      throw new RangeError("Duplicate spatial feature ID: " + id);
    seen.add(id);
    ids[tree.add(...bounds)] = id;
  }
  return finishIndex(tree, ids, revision);
}
function applySpatialEdits(previous, revision, edits) {
  checkRevision(revision);
  const changes = previous ?? new SharedMap2(json2());
  const batch = new Map;
  for (const { id, bounds } of edits) {
    checkId(id);
    if (bounds !== null)
      checkBounds(bounds, true);
    batch.set(String(id), { revision, bounds });
  }
  const writes = [];
  for (const [key, change] of batch) {
    const last = changes.get(key);
    if (last && last.revision >= revision) {
      if (last.revision === revision && (last.bounds === change.bounds || last.bounds && change.bounds && last.bounds.every((v, i) => v === change.bounds[i])))
        continue;
      throw new RangeError("Conflicting or older spatial edit for feature " + key);
    }
    writes.push([key, change]);
  }
  return changes.setMany(writes);
}
function treeFor(base) {
  let tree = trees.get(base);
  if (!tree) {
    checkRevision(base.revision);
    if (base.format !== 1 || !(base.ids instanceof Uint32Array) || !(base.ids.buffer instanceof SharedArrayBuffer)) {
      throw new TypeError("Invalid shared spatial index");
    }
    if (base.buffer !== null) {
      if (!(base.buffer instanceof SharedArrayBuffer))
        throw new TypeError("Expected shared Flatbush storage");
      tree = Flatbush.from(base.buffer);
      if (tree.numItems !== base.ids.length)
        throw new RangeError("Spatial index and feature ID count differ");
      trees.set(base, tree);
    } else if (base.ids.length)
      throw new RangeError("Missing spatial index for feature IDs");
  }
  return tree;
}
function collectChanges(base, changes, revision) {
  checkRevision(revision);
  if (revision < base.revision)
    throw new RangeError("Cannot capture changes before the base revision");
  const edits = new Map;
  let liveCount = 0;
  for (const [key, change] of changes.entries()) {
    checkRevision(change.revision);
    if (change.revision > revision)
      throw new RangeError("Spatial overlay is newer than the requested revision");
    if (change.revision <= base.revision)
      continue;
    const id = Number(key);
    checkId(id);
    if (String(id) !== key)
      throw new TypeError("Expected a canonical spatial feature ID");
    if (change.bounds !== null) {
      checkBounds(change.bounds, true);
      liveCount++;
    }
    edits.set(id, change.bounds);
  }
  return { edits, liveCount };
}
function prepareSpatialQuery(base, changes, revision) {
  treeFor(base);
  const { edits, liveCount } = collectChanges(base, changes, revision);
  const changedIds = new Uint32Array(new SharedArrayBuffer(edits.size * 4));
  const liveIds = new Uint32Array(new SharedArrayBuffer(liveCount * 4));
  const tree = liveCount ? new Flatbush(liveCount, 16, Float64Array, SharedArrayBuffer) : undefined;
  let i = 0;
  for (const [id, bounds] of edits) {
    changedIds[i++] = id;
    if (bounds)
      liveIds[tree.add(...bounds)] = id;
  }
  changedIds.sort();
  return Object.freeze({ format: "spatial-query-v1", revision, base, changedIds, updates: finishIndex(tree, liveIds, revision) });
}
function containsId(ids, id) {
  let low = 0, high = ids.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (ids[mid] < id)
      low = mid + 1;
    else
      high = mid;
  }
  return ids[low] === id;
}
function rebuildSpatialIndex(base, changes, revision) {
  const tree = treeFor(base);
  const { edits, liveCount } = collectChanges(base, changes, revision);
  if (!edits.size) {
    if (revision === base.revision)
      return base;
    const next = Object.freeze({ ...base, revision });
    if (tree)
      trees.set(next, tree);
    return next;
  }
  let count = base.ids.length + liveCount;
  for (const id of base.ids)
    if (edits.has(id))
      count--;
  const ids = new Uint32Array(new SharedArrayBuffer(count * 4));
  const next = count ? new Flatbush(count, 16, Float64Array, SharedArrayBuffer) : undefined;
  if (next) {
    tree?.search(-Infinity, -Infinity, Infinity, Infinity, (slot, x0, y0, x1, y1) => {
      const id = base.ids[slot];
      if (!edits.has(id))
        ids[next.add(x0, y0, x1, y1)] = id;
      return false;
    });
    for (const [id, bounds] of edits)
      if (bounds)
        ids[next.add(...bounds)] = id;
  }
  return finishIndex(next, ids, revision);
}
function querySpatialIndex(index, box, changes) {
  checkBounds(box, false);
  if (index.format === "spatial-query-v1") {
    if (changes !== undefined)
      throw new TypeError("A prepared spatial query already includes its changes");
    const { base, updates, changedIds } = index;
    if (!(changedIds instanceof Uint32Array) || !(changedIds.buffer instanceof SharedArrayBuffer)) {
      throw new TypeError("Expected shared spatial change IDs");
    }
    const result = [];
    for (const slot of treeFor(base)?.search(...box) ?? []) {
      const id = base.ids[slot];
      if (!containsId(changedIds, id))
        result.push(id);
    }
    for (const slot of treeFor(updates)?.search(...box) ?? [])
      result.push(updates.ids[slot]);
    return result.sort((a, b) => a - b);
  }
  const base = index;
  const tree = treeFor(base);
  const result = [];
  if (tree) {
    for (const slot of tree.search(...box)) {
      const id = base.ids[slot], edit = changes?.get(String(id));
      if (!edit || edit.revision <= base.revision)
        result.push(id);
    }
  }
  if (changes) {
    for (const [key, { revision, bounds }] of changes.entries()) {
      if (revision > base.revision && bounds && bounds[0] <= box[2] && bounds[1] <= box[3] && bounds[2] >= box[0] && bounds[3] >= box[1])
        result.push(Number(key));
    }
  }
  return result.sort((a, b) => a - b);
}
function pruneSpatialEdits(changes, baseRevision) {
  checkRevision(baseRevision);
  const obsolete = [];
  for (const [key, edit] of changes.entries())
    if (edit.revision <= baseRevision)
      obsolete.push(key);
  return obsolete.length ? changes.deleteMany(obsolete) : changes;
}
export {
  applySpatialEdits,
  buildSpatialIndex,
  prepareSpatialQuery,
  pruneSpatialEdits,
  querySpatialIndex,
  rebuildSpatialIndex
};
