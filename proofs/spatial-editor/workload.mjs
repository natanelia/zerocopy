// Projected XY coordinates in metres. Recreating a lane reproduces its import.
export function lane(id, vertices) {
  const path = new Float64Array(vertices * 2);
  const x = (id % 64) * 8, y = Math.floor(id / 64) * 12;
  for (let i = 0; i < vertices; i++) {
    path[i * 2] = x + 5 * i / (vertices - 1);
    path[i * 2 + 1] = y + (i % 5) / 8;
  }
  return path;
}

export function bounds(xy) {
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  for (let i = 0; i < xy.length; i += 2) {
    left = Math.min(left, xy[i]); bottom = Math.min(bottom, xy[i + 1]);
    right = Math.max(right, xy[i]); top = Math.max(top, xy[i + 1]);
  }
  return [left, bottom, right, top];
}

export const west = [-3, -3, 34, 17];
export const east = [37, -3, 72, 17];

// Each cycle returns to the original tile so runs can use the same edit trace.
export function edit(step, vertices) {
  const id = String(5 + Math.floor(step / 10) % 4);
  const original = lane(Number(id), vertices);
  switch (step % 10) {
    case 0: return { id, moveX: 32 }; // pull one vertex into the western viewport
    case 1: return { box: east };
    case 2: return { id, path: Float64Array.of(...original.subarray(0, 2), 35, 1, ...original.subarray(2)) };
    case 3: return { id, remove: true };
    case 4: return { id, path: original }; // undo deletion
    case 5: return { id, moveX: 12, reject: true };
    case 6: return { box: west };
    case 7: return { id: '1', moveY: 8 }; // same membership and vertex count
    case 8: return { id: '1', moveY: 0 }; // undo the drag
    case 9: return { id, moveX: original[0] };
  }
}

export function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
