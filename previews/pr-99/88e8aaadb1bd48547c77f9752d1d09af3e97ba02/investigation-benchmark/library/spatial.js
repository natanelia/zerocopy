import {
  json2,
  arenaOf
} from "./chunk-953e7ch3.js";
import {
  SharedMap2
} from "./chunk-xp6v3e8t.js";
import {
  checkSpatialId,
  lowerBoundUint32
} from "./chunk-vt8h7fk7.js";
import {
  packedBoundsXY,
  checkBounds,
  lineStringViewXY2,
  lineStringPresent,
  validateLineStringBuffersXY
} from "./chunk-zapt1m2x.js";

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

// node_modules/quickselect/index.js
function quickselect(arr, k, left = 0, right = arr.length - 1, compare = defaultCompare) {
  while (right > left) {
    if (right - left > 600) {
      const n = right - left + 1;
      const m = k - left + 1;
      const z = Math.log(n);
      const s = 0.5 * Math.exp(2 * z / 3);
      const sd = 0.5 * Math.sqrt(z * s * (n - s) / n) * (m - n / 2 < 0 ? -1 : 1);
      const newLeft = Math.max(left, Math.floor(k - m * s / n + sd));
      const newRight = Math.min(right, Math.floor(k + (n - m) * s / n + sd));
      quickselect(arr, k, newLeft, newRight, compare);
    }
    const t = arr[k];
    let i = left;
    let j = right;
    swap2(arr, left, k);
    if (compare(arr[right], t) > 0)
      swap2(arr, left, right);
    while (i < j) {
      swap2(arr, i, j);
      i++;
      j--;
      while (compare(arr[i], t) < 0)
        i++;
      while (compare(arr[j], t) > 0)
        j--;
    }
    if (compare(arr[left], t) === 0)
      swap2(arr, left, j);
    else {
      j++;
      swap2(arr, j, right);
    }
    if (j <= k)
      left = j + 1;
    if (k <= j)
      right = j - 1;
  }
}
function swap2(arr, i, j) {
  const tmp = arr[i];
  arr[i] = arr[j];
  arr[j] = tmp;
}
function defaultCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// node_modules/rbush/index.js
class RBush {
  constructor(maxEntries = 9) {
    this._maxEntries = Math.max(4, maxEntries);
    this._minEntries = Math.max(2, Math.ceil(this._maxEntries * 0.4));
    this.clear();
  }
  all() {
    return this._all(this.data, []);
  }
  search(bbox) {
    let node = this.data;
    const result = [];
    if (!intersects(bbox, node))
      return result;
    const toBBox = this.toBBox;
    const nodesToSearch = [];
    while (node) {
      for (let i = 0;i < node.children.length; i++) {
        const child = node.children[i];
        const childBBox = node.leaf ? toBBox(child) : child;
        if (intersects(bbox, childBBox)) {
          if (node.leaf)
            result.push(child);
          else if (contains(bbox, childBBox))
            this._all(child, result);
          else
            nodesToSearch.push(child);
        }
      }
      node = nodesToSearch.pop();
    }
    return result;
  }
  collides(bbox) {
    let node = this.data;
    if (!intersects(bbox, node))
      return false;
    const nodesToSearch = [];
    while (node) {
      for (let i = 0;i < node.children.length; i++) {
        const child = node.children[i];
        const childBBox = node.leaf ? this.toBBox(child) : child;
        if (intersects(bbox, childBBox)) {
          if (node.leaf || contains(bbox, childBBox))
            return true;
          nodesToSearch.push(child);
        }
      }
      node = nodesToSearch.pop();
    }
    return false;
  }
  load(data) {
    if (!(data && data.length))
      return this;
    if (data.length < this._minEntries) {
      for (let i = 0;i < data.length; i++) {
        this.insert(data[i]);
      }
      return this;
    }
    let node = this._build(data.slice(), 0, data.length - 1, 0);
    if (!this.data.children.length) {
      this.data = node;
    } else if (this.data.height === node.height) {
      this._splitRoot(this.data, node);
    } else {
      if (this.data.height < node.height) {
        const tmpNode = this.data;
        this.data = node;
        node = tmpNode;
      }
      this._insert(node, this.data.height - node.height - 1, true);
    }
    return this;
  }
  insert(item) {
    if (item)
      this._insert(item, this.data.height - 1);
    return this;
  }
  clear() {
    this.data = createNode([]);
    return this;
  }
  remove(item, equalsFn) {
    if (!item)
      return this;
    let node = this.data;
    const bbox = this.toBBox(item);
    const path = [];
    const indexes = [];
    let i, parent, goingUp;
    while (node || path.length) {
      if (!node) {
        node = path.pop();
        parent = path[path.length - 1];
        i = indexes.pop();
        goingUp = true;
      }
      if (node.leaf) {
        const index = findItem(item, node.children, equalsFn);
        if (index !== -1) {
          node.children.splice(index, 1);
          path.push(node);
          this._condense(path);
          return this;
        }
      }
      if (!goingUp && !node.leaf && contains(node, bbox)) {
        path.push(node);
        indexes.push(i);
        i = 0;
        parent = node;
        node = node.children[0];
      } else if (parent) {
        i++;
        node = parent.children[i];
        goingUp = false;
      } else
        node = null;
    }
    return this;
  }
  toBBox(item) {
    return item;
  }
  compareMinX(a, b) {
    return a.minX - b.minX;
  }
  compareMinY(a, b) {
    return a.minY - b.minY;
  }
  toJSON() {
    return this.data;
  }
  fromJSON(data) {
    this.data = data;
    return this;
  }
  _all(node, result) {
    const nodesToSearch = [];
    while (node) {
      if (node.leaf)
        result.push(...node.children);
      else
        nodesToSearch.push(...node.children);
      node = nodesToSearch.pop();
    }
    return result;
  }
  _build(items, left, right, height) {
    const N = right - left + 1;
    let M = this._maxEntries;
    let node;
    if (N <= M) {
      node = createNode(items.slice(left, right + 1));
      calcBBox(node, this.toBBox);
      return node;
    }
    if (!height) {
      height = Math.ceil(Math.log(N) / Math.log(M));
      M = Math.ceil(N / Math.pow(M, height - 1));
    }
    node = createNode([]);
    node.leaf = false;
    node.height = height;
    const N2 = Math.ceil(N / M);
    const N1 = N2 * Math.ceil(Math.sqrt(M));
    multiSelect(items, left, right, N1, this.compareMinX);
    for (let i = left;i <= right; i += N1) {
      const right2 = Math.min(i + N1 - 1, right);
      multiSelect(items, i, right2, N2, this.compareMinY);
      for (let j = i;j <= right2; j += N2) {
        const right3 = Math.min(j + N2 - 1, right2);
        node.children.push(this._build(items, j, right3, height - 1));
      }
    }
    calcBBox(node, this.toBBox);
    return node;
  }
  _chooseSubtree(bbox, node, level, path) {
    while (true) {
      path.push(node);
      if (node.leaf || path.length - 1 === level)
        break;
      let minArea = Infinity;
      let minEnlargement = Infinity;
      let targetNode;
      for (let i = 0;i < node.children.length; i++) {
        const child = node.children[i];
        const area = bboxArea(child);
        const enlargement = enlargedArea(bbox, child) - area;
        if (enlargement < minEnlargement) {
          minEnlargement = enlargement;
          minArea = area < minArea ? area : minArea;
          targetNode = child;
        } else if (enlargement === minEnlargement) {
          if (area < minArea) {
            minArea = area;
            targetNode = child;
          }
        }
      }
      node = targetNode || node.children[0];
    }
    return node;
  }
  _insert(item, level, isNode) {
    const bbox = isNode ? item : this.toBBox(item);
    const insertPath = [];
    const node = this._chooseSubtree(bbox, this.data, level, insertPath);
    node.children.push(item);
    extend(node, bbox);
    while (level >= 0) {
      if (insertPath[level].children.length > this._maxEntries) {
        this._split(insertPath, level);
        level--;
      } else
        break;
    }
    this._adjustParentBBoxes(bbox, insertPath, level);
  }
  _split(insertPath, level) {
    const node = insertPath[level];
    const M = node.children.length;
    const m = this._minEntries;
    this._chooseSplitAxis(node, m, M);
    const splitIndex = this._chooseSplitIndex(node, m, M);
    const newNode = createNode(node.children.splice(splitIndex, node.children.length - splitIndex));
    newNode.height = node.height;
    newNode.leaf = node.leaf;
    calcBBox(node, this.toBBox);
    calcBBox(newNode, this.toBBox);
    if (level)
      insertPath[level - 1].children.push(newNode);
    else
      this._splitRoot(node, newNode);
  }
  _splitRoot(node, newNode) {
    this.data = createNode([node, newNode]);
    this.data.height = node.height + 1;
    this.data.leaf = false;
    calcBBox(this.data, this.toBBox);
  }
  _chooseSplitIndex(node, m, M) {
    let index;
    let minOverlap = Infinity;
    let minArea = Infinity;
    for (let i = m;i <= M - m; i++) {
      const bbox1 = distBBox(node, 0, i, this.toBBox);
      const bbox2 = distBBox(node, i, M, this.toBBox);
      const overlap = intersectionArea(bbox1, bbox2);
      const area = bboxArea(bbox1) + bboxArea(bbox2);
      if (overlap < minOverlap) {
        minOverlap = overlap;
        index = i;
        minArea = area < minArea ? area : minArea;
      } else if (overlap === minOverlap) {
        if (area < minArea) {
          minArea = area;
          index = i;
        }
      }
    }
    return index || M - m;
  }
  _chooseSplitAxis(node, m, M) {
    const compareMinX = node.leaf ? this.compareMinX : compareNodeMinX;
    const compareMinY = node.leaf ? this.compareMinY : compareNodeMinY;
    const xMargin = this._allDistMargin(node, m, M, compareMinX);
    const yMargin = this._allDistMargin(node, m, M, compareMinY);
    if (xMargin < yMargin)
      node.children.sort(compareMinX);
  }
  _allDistMargin(node, m, M, compare) {
    node.children.sort(compare);
    const toBBox = this.toBBox;
    const leftBBox = distBBox(node, 0, m, toBBox);
    const rightBBox = distBBox(node, M - m, M, toBBox);
    let margin = bboxMargin(leftBBox) + bboxMargin(rightBBox);
    for (let i = m;i < M - m; i++) {
      const child = node.children[i];
      extend(leftBBox, node.leaf ? toBBox(child) : child);
      margin += bboxMargin(leftBBox);
    }
    for (let i = M - m - 1;i >= m; i--) {
      const child = node.children[i];
      extend(rightBBox, node.leaf ? toBBox(child) : child);
      margin += bboxMargin(rightBBox);
    }
    return margin;
  }
  _adjustParentBBoxes(bbox, path, level) {
    for (let i = level;i >= 0; i--) {
      extend(path[i], bbox);
    }
  }
  _condense(path) {
    for (let i = path.length - 1, siblings;i >= 0; i--) {
      if (path[i].children.length === 0) {
        if (i > 0) {
          siblings = path[i - 1].children;
          siblings.splice(siblings.indexOf(path[i]), 1);
        } else
          this.clear();
      } else
        calcBBox(path[i], this.toBBox);
    }
  }
}
function findItem(item, items, equalsFn) {
  if (!equalsFn)
    return items.indexOf(item);
  for (let i = 0;i < items.length; i++) {
    if (equalsFn(item, items[i]))
      return i;
  }
  return -1;
}
function calcBBox(node, toBBox) {
  distBBox(node, 0, node.children.length, toBBox, node);
}
function distBBox(node, k, p, toBBox, destNode) {
  if (!destNode)
    destNode = createNode(null);
  destNode.minX = Infinity;
  destNode.minY = Infinity;
  destNode.maxX = -Infinity;
  destNode.maxY = -Infinity;
  for (let i = k;i < p; i++) {
    const child = node.children[i];
    extend(destNode, node.leaf ? toBBox(child) : child);
  }
  return destNode;
}
function extend(a, b) {
  a.minX = Math.min(a.minX, b.minX);
  a.minY = Math.min(a.minY, b.minY);
  a.maxX = Math.max(a.maxX, b.maxX);
  a.maxY = Math.max(a.maxY, b.maxY);
  return a;
}
function compareNodeMinX(a, b) {
  return a.minX - b.minX;
}
function compareNodeMinY(a, b) {
  return a.minY - b.minY;
}
function bboxArea(a) {
  return (a.maxX - a.minX) * (a.maxY - a.minY);
}
function bboxMargin(a) {
  return a.maxX - a.minX + (a.maxY - a.minY);
}
function enlargedArea(a, b) {
  return (Math.max(b.maxX, a.maxX) - Math.min(b.minX, a.minX)) * (Math.max(b.maxY, a.maxY) - Math.min(b.minY, a.minY));
}
function intersectionArea(a, b) {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
}
function contains(a, b) {
  return a.minX <= b.minX && a.minY <= b.minY && b.maxX <= a.maxX && b.maxY <= a.maxY;
}
function intersects(a, b) {
  return b.minX <= a.maxX && b.minY <= a.maxY && b.maxX >= a.minX && b.maxY >= a.minY;
}
function createNode(children) {
  return {
    children,
    height: 1,
    leaf: true,
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity
  };
}
function multiSelect(arr, left, right, n, compare) {
  const stack = [left, right];
  while (stack.length) {
    right = stack.pop();
    left = stack.pop();
    if (right - left <= n)
      continue;
    const mid = left + Math.ceil((right - left) / n / 2) * n;
    quickselect(arr, mid, left, right, compare);
    stack.push(left, mid, mid, right);
  }
}

// line-string-lookup.ts
function checkLineStringBatch({ paths, ids }) {
  validateLineStringBuffersXY(paths);
  if (ids.length !== paths.offsets.length - 1)
    throw new RangeError("Expected one spatial feature ID per LineString row");
}
function buildLineStringLookup(batches) {
  const batchEnds = new Uint32Array(new SharedArrayBuffer(batches.length * 4));
  let total = 0;
  for (let i = 0;i < batches.length; i++) {
    checkLineStringBatch(batches[i]);
    total += batches[i].ids.length;
    if (total > 4294967295)
      throw new RangeError("Too many rows for a uint32 LineString lookup");
    batchEnds[i] = total;
  }
  const ids = new Uint32Array(new SharedArrayBuffer(total * 4));
  let offset = 0, sorted = true;
  for (const batch of batches) {
    for (const id of batch.ids) {
      checkSpatialId(id);
      if (offset > 0 && id < ids[offset - 1])
        sorted = false;
      ids[offset++] = id;
    }
  }
  let rows = null;
  if (!sorted) {
    rows = new Uint32Array(new SharedArrayBuffer(total * 4));
    for (let i = 0;i < total; i++)
      rows[i] = i;
    rows.sort((a, b) => ids[a] - ids[b]);
    ids.sort();
  }
  for (let i = 1;i < total; i++) {
    if (ids[i] === ids[i - 1])
      throw new RangeError("Duplicate spatial feature ID: " + ids[i]);
  }
  const geometry = batches.map(({ paths: { offsets, coordinates, validity } }) => Object.freeze({ offsets, coordinates, validity }));
  return Object.freeze({ batches: Object.freeze(geometry), ids, rows, batchEnds });
}
function getLineStringById(lookup, id) {
  checkSpatialId(id);
  const slot = lowerBoundUint32(lookup.ids, id);
  if (lookup.ids[slot] !== id)
    return;
  const ordinal = lookup.rows === null ? slot : lookup.rows[slot];
  const batch = lowerBoundUint32(lookup.batchEnds, ordinal + 1);
  const start = batch === 0 ? 0 : lookup.batchEnds[batch - 1];
  return lineStringViewXY2(lookup.batches[batch], ordinal - start);
}

// spatial.ts
function checkRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new RangeError("Expected a nonnegative safe spatial revision");
}
var trees = new WeakMap;
var revisionRanges = new WeakMap;
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
    checkSpatialId(id);
    checkBounds(bounds, true);
    if (seen.has(id))
      throw new RangeError("Duplicate spatial feature ID: " + id);
    seen.add(id);
    ids[tree.add(...bounds)] = id;
  }
  return finishIndex(tree, ids, revision);
}
function buildLineStringIndex(batches, revision = 0) {
  checkRevision(revision);
  let count = 0;
  for (const batch of batches) {
    checkLineStringBatch(batch);
    const { paths, ids } = batch;
    const { offsets, coordinates, validity } = paths;
    for (let row = 0;row < ids.length; row++) {
      if (!lineStringPresent(validity, row))
        continue;
      const end = offsets[row + 1] * 2;
      for (let i = offsets[row] * 2;i < end; i += 2) {
        if (Number.isFinite(coordinates[i]) && Number.isFinite(coordinates[i + 1])) {
          count++;
          break;
        }
      }
    }
  }
  const handles = new Uint32Array(new SharedArrayBuffer(count * 4));
  const tree = count ? new Flatbush(count, 16, Float64Array, SharedArrayBuffer) : undefined;
  const seen = new Set;
  for (const { paths: { offsets, coordinates, validity }, ids } of batches) {
    for (let row = 0;row < ids.length; row++) {
      const id = ids[row];
      checkSpatialId(id);
      if (seen.has(id))
        throw new RangeError("Duplicate spatial feature ID: " + id);
      seen.add(id);
      if (!tree || offsets[row] === offsets[row + 1] || !lineStringPresent(validity, row))
        continue;
      const bounds = packedBoundsXY(coordinates, offsets[row] * 2, offsets[row + 1] * 2, true);
      if (bounds[0] !== Infinity)
        handles[tree.add(...bounds)] = id;
    }
  }
  return finishIndex(tree, handles, revision);
}
function applySpatialEdits(previous, revision, edits) {
  checkRevision(revision);
  const changes = previous ?? new SharedMap2(json2());
  const batch = new Map;
  for (const { id, bounds } of edits) {
    checkSpatialId(id);
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
  if (!writes.length)
    return changes;
  const next = changes.setMany(writes);
  const range = revisionRanges.get(changes);
  if (!changes.size || range)
    revisionRanges.set(next, {
      min: Math.min(range?.min ?? revision, revision),
      max: Math.max(range?.max ?? revision, revision)
    });
  return next;
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
function activeChangeId(key, change, baseRevision, revision) {
  checkRevision(change.revision);
  if (change.revision > revision)
    throw new RangeError("Spatial overlay is newer than the requested revision");
  if (change.revision <= baseRevision)
    return;
  const id = Number(key);
  checkSpatialId(id);
  if (String(id) !== key)
    throw new TypeError("Expected a canonical spatial feature ID");
  if (change.bounds !== null)
    checkBounds(change.bounds, true);
  return id;
}
function collectChanges(base, changes, revision) {
  checkRevision(revision);
  if (revision < base.revision)
    throw new RangeError("Cannot capture changes before the base revision");
  const edits = new Map;
  let liveCount = 0;
  for (const [key, change] of changes.entries()) {
    const id = activeChangeId(key, change, base.revision, revision);
    if (id === undefined)
      continue;
    if (change.bounds !== null)
      liveCount++;
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
  return ids[lowerBoundUint32(ids, id)] === id;
}
function checkChangedIds(ids) {
  if (!(ids instanceof Uint32Array) || !(ids.buffer instanceof SharedArrayBuffer)) {
    throw new TypeError("Expected shared spatial change IDs");
  }
}
function overlapsViewport(bounds, viewport) {
  return bounds[0] <= viewport[2] && bounds[1] <= viewport[3] && bounds[2] >= viewport[0] && bounds[3] >= viewport[1];
}
function rtreeBox([minX, minY, maxX, maxY]) {
  return { minX, minY, maxX, maxY };
}
function editBox(id, bounds) {
  return bounds === null ? null : { id, ...rtreeBox(bounds) };
}
function createSpatialQueryCursor(base) {
  const packed = treeFor(base);
  let revision = base.revision;
  let previous;
  let overlay;
  return {
    get revision() {
      return revision;
    },
    advance(changes, nextRevision) {
      checkRevision(nextRevision);
      if (nextRevision < revision)
        throw new RangeError("Cannot move a spatial cursor to an older revision");
      if (!overlay || !previous) {
        const { edits } = collectChanges(base, changes, nextRevision);
        const shadow = new Map, tree = new RBush;
        const live = [];
        for (const [id, bounds] of edits) {
          const item = editBox(id, bounds);
          if (item)
            live.push(item);
          shadow.set(id, item);
        }
        tree.load(live);
        overlay = { tree, shadow };
      } else if (changes !== previous) {
        const patches = new Map;
        for (const { key, before, after } of changes.changesSince(previous)) {
          if (after !== undefined) {
            const id = activeChangeId(key, after, base.revision, nextRevision);
            if (id !== undefined) {
              patches.set(id, editBox(id, after.bounds));
              continue;
            }
          }
          if (before && before.revision > base.revision)
            patches.set(Number(key), undefined);
        }
        const current = overlay;
        overlay = undefined;
        for (const [id, item] of patches) {
          const old = current.shadow.get(id);
          if (old)
            current.tree.remove(old);
          if (item === undefined)
            current.shadow.delete(id);
          else {
            current.shadow.set(id, item);
            if (item)
              current.tree.insert(item);
          }
        }
        overlay = current;
      }
      previous = changes;
      revision = nextRevision;
    },
    search(box) {
      if (!overlay)
        return querySpatialIndex(base, box, previous);
      checkBounds(box, false);
      const result = [];
      for (const slot of packed?.search(...box) ?? []) {
        const id = base.ids[slot];
        if (!overlay.shadow.has(id))
          result.push(id);
      }
      for (const item of overlay.tree.search(rtreeBox(box)))
        result.push(item.id);
      return result.sort((a, b) => a - b);
    }
  };
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
    checkChangedIds(changedIds);
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
      if (revision > base.revision && bounds && overlapsViewport(bounds, box))
        result.push(Number(key));
    }
  }
  return result.sort((a, b) => a - b);
}
function pairOrder(a, b) {
  return a[0] - b[0] || a[1] - b[1];
}
function included(filter, left, right) {
  if (!filter)
    return true;
  const result = filter(left, right);
  if (typeof result !== "boolean")
    throw new TypeError("Spatial join filters must return a boolean");
  return result;
}
function checkFilter(filter) {
  if (filter !== undefined && typeof filter !== "function")
    throw new TypeError("Expected a spatial join filter function");
}
function joinParts(snapshot) {
  const parts = [];
  const add = (index, hidden) => {
    const tree = treeFor(index);
    if (tree)
      parts.push({ tree, ids: index.ids, hidden });
  };
  if (snapshot.format === "spatial-query-v1") {
    checkChangedIds(snapshot.changedIds);
    add(snapshot.base, snapshot.changedIds);
    add(snapshot.updates);
  } else
    add(snapshot);
  return parts;
}
function querySpatialJoin(left, right, options = {}) {
  const { bounds = [-Infinity, -Infinity, Infinity, Infinity], filter } = options;
  checkBounds(bounds, false);
  const [xMin, yMin, xMax, yMax] = bounds;
  checkFilter(filter);
  const result = [];
  const leftParts = joinParts(left), rightParts = joinParts(right);
  for (const l of leftParts)
    for (const r of rightParts) {
      const reverse = r.tree.numItems < l.tree.numItems;
      const outer = reverse ? r : l, inner = reverse ? l : r;
      const minX = Math.max(xMin, outer.tree.minX, inner.tree.minX);
      const minY = Math.max(yMin, outer.tree.minY, inner.tree.minY);
      const maxX = Math.min(xMax, outer.tree.maxX, inner.tree.maxX);
      const maxY = Math.min(yMax, outer.tree.maxY, inner.tree.maxY);
      if (minX > maxX || minY > maxY)
        continue;
      outer.tree.search(minX, minY, maxX, maxY, (slot, x0, y0, x1, y1) => {
        const outerId = outer.ids[slot];
        if (outer.hidden && containsId(outer.hidden, outerId))
          return false;
        inner.tree.search(Math.max(x0, minX), Math.max(y0, minY), Math.min(x1, maxX), Math.min(y1, maxY), (innerSlot) => {
          const innerId = inner.ids[innerSlot];
          if (inner.hidden && containsId(inner.hidden, innerId))
            return false;
          const leftId = reverse ? innerId : outerId, rightId = reverse ? outerId : innerId;
          if (included(filter, leftId, rightId))
            result.push([leftId, rightId]);
          return false;
        });
        return false;
      });
    }
  return result.sort(pairOrder);
}
function changedBounds(edits = []) {
  const changes = new Map;
  for (const { id, before, after } of edits) {
    checkSpatialId(id);
    if (before !== null)
      checkBounds(before, true);
    if (after !== null)
      checkBounds(after, true);
    const first = changes.get(id);
    changes.set(id, { id, before: first ? first.before : before, after });
  }
  return changes;
}
function diffSpatialViewport(viewport, edits, filter) {
  checkBounds(viewport, false);
  if (filter !== undefined && typeof filter !== "function")
    throw new TypeError("Expected a spatial viewport filter function");
  const added = [], removed = [];
  function visible(id, bounds, frame) {
    if (!bounds || !overlapsViewport(bounds, viewport))
      return false;
    if (!filter)
      return true;
    const match = filter(id, frame);
    if (typeof match !== "boolean")
      throw new TypeError("Spatial viewport filters must return a boolean");
    return match;
  }
  for (const { id, before, after } of changedBounds(edits).values()) {
    const wasVisible = visible(id, before, "before");
    const isVisible = visible(id, after, "after");
    if (isVisible && !wasVisible)
      added.push(id);
    if (wasVisible && !isVisible)
      removed.push(id);
  }
  return { added: added.sort((a, b) => a - b), removed: removed.sort((a, b) => a - b) };
}
function diffSpatialJoin(previous, next, changes) {
  const { bounds = [-Infinity, -Infinity, Infinity, Infinity] } = changes;
  checkBounds(bounds, false);
  const [x0, y0, x1, y1] = bounds;
  checkFilter(previous.filter);
  checkFilter(next.filter);
  const left = changedBounds(changes.left), right = changedBounds(changes.right);
  const added = [], removed = [];
  function neighbors(frame, id, box, fromLeft) {
    const matches = new Set;
    if (!box)
      return matches;
    const clipped = [Math.max(x0, box[0]), Math.max(y0, box[1]), Math.min(x1, box[2]), Math.min(y1, box[3])];
    if (clipped[0] > clipped[2] || clipped[1] > clipped[3])
      return matches;
    for (const other of querySpatialIndex(fromLeft ? frame.right : frame.left, clipped)) {
      if (!fromLeft && left.has(other))
        continue;
      if (included(frame.filter, fromLeft ? id : other, fromLeft ? other : id))
        matches.add(other);
    }
    return matches;
  }
  function compare(edit, fromLeft) {
    const before = neighbors(previous, edit.id, edit.before, fromLeft);
    const after = neighbors(next, edit.id, edit.after, fromLeft);
    for (const id of before)
      if (!after.has(id))
        removed.push(fromLeft ? [edit.id, id] : [id, edit.id]);
    for (const id of after)
      if (!before.has(id))
        added.push(fromLeft ? [edit.id, id] : [id, edit.id]);
  }
  for (const edit of left.values())
    compare(edit, true);
  for (const edit of right.values())
    compare(edit, false);
  return { added: added.sort(pairOrder), removed: removed.sort(pairOrder) };
}
function pruneSpatialEdits(changes, baseRevision, captured) {
  checkRevision(baseRevision);
  if (!changes.size)
    return changes;
  const range = revisionRanges.get(changes);
  if (range && range.min > baseRevision)
    return changes;
  const arena = arenaOf(changes);
  if (range && range.max <= baseRevision) {
    arena.assertWritable();
    return new SharedMap2(changes.valueType, 0, 0, arena);
  }
  const covered = captured && captured.size * 2 >= changes.size && arenaOf(captured) === arena && (revisionRanges.get(captured)?.max ?? Infinity) <= baseRevision ? captured.root : 0;
  const keep = [], drop = [];
  let min = Infinity, max = 0;
  for (const leaf of covered ? arena.uncoveredMapLeaves(changes.root, covered) : arena.leaves(changes.root)) {
    const edit = arena.leafValue(changes.valueType, leaf);
    if (edit.revision <= baseRevision) {
      if (!covered)
        drop.push(leaf);
    } else {
      keep.push(leaf);
      min = Math.min(min, edit.revision);
      max = Math.max(max, edit.revision);
    }
  }
  if (keep.length === changes.size)
    return changes;
  const next = !covered && drop.length < keep.length ? changes.deleteMany(drop.map((leaf) => arena.leafKey(leaf))) : new SharedMap2(changes.valueType, arena.mergeMapLeaves(0, keep), keep.length, arena);
  if (next.size)
    revisionRanges.set(next, { min, max });
  return next;
}
export {
  applySpatialEdits,
  buildLineStringIndex,
  buildLineStringLookup,
  buildSpatialIndex,
  createSpatialQueryCursor,
  diffSpatialJoin,
  diffSpatialViewport,
  getLineStringById,
  prepareSpatialQuery,
  pruneSpatialEdits,
  querySpatialIndex,
  querySpatialJoin,
  rebuildSpatialIndex
};
