/**
 * Deterministic supplied-text fixtures only: no filesystem reads, subprocesses,
 * live /proc or cgroup probes, process counters, or benchmarks.
 * All paths are Map keys. These are conceptual cgroup-v2 interface fixtures,
 * never observations of the machine on which the tests are authored or run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryHeadroom } from './full-memory-headroom.mjs';

const GiB = 1024 ** 3;
const ROOT = '/mock/cgroup';
const HOST_MOUNT = '10 1 0:10 / / rw - ext4 /dev/mock rw\n';
const fileError = code => Object.assign(new Error(`Supplied fixture error: ${code}`), { code });
const escapeMount = path => path.replaceAll('\\', '\\134').replaceAll(' ', '\\040');
const v2Mount = (root = '/', point = ROOT) =>
  `20 10 0:20 ${escapeMount(root)} ${escapeMount(point)} rw - cgroup2 cgroup rw\n`;

function fixture({ membershipPath = '/parent/job', mountRoot = '/', mountPoint = ROOT } = {}) {
  const data = new Map([
    ['/proc/meminfo', `MemTotal: ${16 * GiB / 1024} kB\nMemAvailable: ${8 * GiB / 1024} kB\n`],
    ['/proc/self/cgroup', `0::${membershipPath}\n`],
    ['/proc/self/mountinfo', HOST_MOUNT + v2Mount(mountRoot, mountPoint)],
    [`${mountPoint}/cgroup.controllers`, 'cpuset cpu io memory pids\n'],
    [`${mountPoint}/cgroup.subtree_control`, 'cpu memory pids\n'],
    [`${mountPoint}/cgroup.stat`, 'nr_descendants 2\nnr_dying_descendants 0\n'],
    [`${mountPoint}/cgroup.type`, fileError('ENOENT')],
    [`${mountPoint}/cgroup.events`, fileError('ENOENT')],
    [`${mountPoint}/memory.max`, fileError('ENOENT')],
    [`${mountPoint}/memory.current`, fileError('ENOENT')],
  ]);
  const reads = [];
  const set = (path, limit, current) => {
    data.set(`${mountPoint}${path}/memory.max`, String(limit));
    data.set(`${mountPoint}${path}/memory.current`, String(current));
  };
  set('/parent/job', 4 * GiB, GiB);
  set('/parent', 2 * GiB, GiB / 2);
  const read = path => {
    reads.push(path);
    if (!data.has(path)) throw fileError('ENOENT');
    const value = data.get(path);
    if (value instanceof Error) throw value;
    assert.equal(typeof value, 'string', `Fixture must supply text or an Error: ${path}`);
    return value;
  };
  return { data, reads, read, set };
}

function assertProvedRoot(value) {
  assert.equal(value.cgroup.version, 2);
  assert.ok(value.cgroup.rootProof && typeof value.cgroup.rootProof === 'object');
  assert.ok(Object.keys(value.cgroup.rootProof).length > 0, 'Root proof must retain evidence');
  const roots = value.cgroup.groups.filter(group => group.hierarchyPath === '/');
  assert.equal(roots.length, 1);
  assert.equal(roots[0].limitKind, 'proved-unconstrained-root');
  assert.ok(roots[0].limitBytes == null, 'A proved root must not invent a limit');
  assert.ok(roots[0].currentBytes == null, 'A proved root must not invent usage');
  assert.ok(roots[0].headroomBytes == null, 'A proved root must not invent headroom');
}

test('an owner at the actual root uses host headroom and retains root proof', () => {
  const { read, reads } = fixture({ membershipPath: '/' });
  const value = memoryHeadroom(read);
  assert.equal(value.totalBytes, 16 * GiB);
  assert.equal(value.availableBytes, 8 * GiB);
  assert.equal(value.effectiveHeadroomBytes, 8 * GiB);
  assert.equal(value.limitingSource.kind, 'host');
  assert.equal(value.cgroup.groups.length, 1);
  assertProvedRoot(value);
  for (const name of ['cgroup.controllers', 'cgroup.subtree_control', 'cgroup.stat', 'cgroup.type', 'cgroup.events', 'memory.max', 'memory.current']) {
    assert.ok(reads.includes(`${ROOT}/${name}`), `Root proof must observe ${name}`);
  }
});

test('a tighter ancestor below a proved actual root limits own-group headroom', () => {
  const value = memoryHeadroom(fixture().read);
  assert.equal(value.effectiveHeadroomBytes, 1.5 * GiB);
  assert.equal(value.limitingSource.kind, 'cgroup-v2');
  assert.equal(value.limitingSource.hierarchyPath, '/parent');
  assert.deepEqual(value.cgroup.groups.map(group => group.hierarchyPath), ['/parent/job', '/parent', '/']);
  assert.equal(value.cgroup.groups[0].limitBytes, String(4 * GiB));
  assert.equal(value.cgroup.groups[1].currentBytes, String(GiB / 2));
  assertProvedRoot(value);
});

test('an own-group limit can be tighter than its ancestor and host', () => {
  const { read, set } = fixture();
  set('/parent/job', GiB, 3 * GiB / 4);
  const value = memoryHeadroom(read);
  assert.equal(value.effectiveHeadroomBytes, GiB / 4);
  assert.equal(value.limitingSource.hierarchyPath, '/parent/job');
  assertProvedRoot(value);
});

test('all explicit max limits below an actual root leave host headroom as the bound', () => {
  const { read, set } = fixture();
  set('/parent/job', 'max', GiB);
  set('/parent', 'max', 2 * GiB);
  const value = memoryHeadroom(read);
  assert.equal(value.effectiveHeadroomBytes, 8 * GiB);
  assert.equal(value.limitingSource.kind, 'host');
  for (const group of value.cgroup.groups.slice(0, 2)) {
    assert.equal(group.limitKind, 'explicit-unlimited');
    assert.equal(group.limitBytes, null);
    assert.ok(group.currentBytes != null);
  }
  assertProvedRoot(value);
});

test('host availability stays the minimum when finite cgroup headrooms are larger', () => {
  const { data, read } = fixture();
  data.set('/proc/meminfo', 'MemTotal: 16777216 kB\nMemAvailable: 1024 kB\n');
  const value = memoryHeadroom(read);
  assert.equal(value.effectiveHeadroomBytes, 1024 * 1024);
  assert.equal(value.limitingSource.kind, 'host');
});

test('finite limits and usage preserve exact integers above Number safe precision', () => {
  const { read, set } = fixture();
  set('/parent/job', 'max', '9007199254741000');
  set('/parent', '9007199254741011', '9007199254741006');
  const value = memoryHeadroom(read);
  assert.equal(value.effectiveHeadroomBytes, 5);
  assert.equal(value.limitingSource.limitBytes, '9007199254741011');
  assert.equal(value.limitingSource.currentBytes, '9007199254741006');
  assert.equal(value.cgroup.groups[0].currentBytes, '9007199254741000');
  assert.equal(value.cgroup.groups[1].limitKind, 'numeric-hard-limit');
});

for (const [limit, current] of [[GiB, GiB], [GiB, 2 * GiB], [0, 0]]) {
  test(`exhausted finite ancestor ${limit}/${current} yields zero headroom`, () => {
    const { read, set } = fixture();
    set('/parent', limit, current);
    assert.equal(memoryHeadroom(read).effectiveHeadroomBytes, 0);
  });
}

test('empty subtree_control is valid when root memory is available', () => {
  const { data, read } = fixture({ membershipPath: '/' });
  data.set(`${ROOT}/cgroup.subtree_control`, '\n');
  assertProvedRoot(memoryHeadroom(read));
});

test('additional numeric cgroup.stat fields and reordered mandatory fields are valid', () => {
  const { data, read } = fixture();
  data.set(`${ROOT}/cgroup.stat`, 'nr_dying_descendants 0\nnew_kernel_counter 17\nnr_descendants 2\n');
  assertProvedRoot(memoryHeadroom(read));
});

test('escaped mount points map to the supplied core files and counters', () => {
  const value = memoryHeadroom(fixture({ mountPoint: '/mock/cgroup space' }).read);
  assert.equal(value.effectiveHeadroomBytes, 1.5 * GiB);
  assert.equal(value.cgroup.mountPoint, '/mock/cgroup space');
  assertProvedRoot(value);
});

for (const limit of ['2147483648', 'max']) {
  test(`a namespace root with memory.max=${limit} is rejected`, () => {
    const { data, read, set } = fixture({ membershipPath: '/' });
    data.set(`${ROOT}/cgroup.type`, 'domain\n');
    data.set(`${ROOT}/cgroup.events`, 'populated 1\nfrozen 0\n');
    set('', limit, GiB / 2);
    assert.throws(() => memoryHeadroom(read));
  });
}

test('a memory-disabled namespace root with type and events present is rejected', () => {
  const { data, read } = fixture({ membershipPath: '/' });
  data.set(`${ROOT}/cgroup.type`, 'domain\n');
  data.set(`${ROOT}/cgroup.events`, 'populated 1\nfrozen 0\n');
  data.set(`${ROOT}/cgroup.controllers`, 'cpu pids\n');
  data.set(`${ROOT}/cgroup.subtree_control`, '\n');
  assert.throws(() => memoryHeadroom(read));
});

for (const [name, contents] of [['cgroup.type', 'domain\n'], ['cgroup.events', 'populated 1\nfrozen 0\n']]) {
  for (const present of [contents, '']) {
    test(`one present marker ${name}=${JSON.stringify(present)} defeats root proof`, () => {
      const { data, read } = fixture();
      data.set(`${ROOT}/${name}`, present);
      assert.throws(() => memoryHeadroom(read));
    });
  }
}

for (const name of ['cgroup.type', 'cgroup.events', 'memory.max', 'memory.current']) {
  for (const code of ['EACCES', 'EIO']) {
    test(`${code} for root ${name} is not ENOENT evidence`, () => {
      const { data, read } = fixture();
      data.set(`${ROOT}/${name}`, fileError(code));
      assert.throws(() => memoryHeadroom(read));
    });
  }
}

for (const [name, contents] of [['memory.max', 'max\n'], ['memory.max', '2147483648\n'], ['memory.current', '0\n']]) {
  test(`present root ${name}=${contents.trim()} with its peer absent defeats proof`, () => {
    const { data, read } = fixture();
    data.set(`${ROOT}/${name}`, contents);
    assert.throws(() => memoryHeadroom(read));
  });
}

test('present root memory files defeat proof even when namespace markers are absent', () => {
  const { read, set } = fixture();
  set('', 'max', 0);
  assert.throws(() => memoryHeadroom(read));
});

for (const name of ['cgroup.controllers', 'cgroup.subtree_control', 'cgroup.stat']) {
  for (const code of ['ENOENT', 'EACCES', 'EIO']) {
    test(`mandatory root ${name} must be readable (${code})`, () => {
      const { data, read } = fixture();
      data.set(`${ROOT}/${name}`, fileError(code));
      assert.throws(() => memoryHeadroom(read));
    });
  }
}

for (const controllers of ['', 'cpu io pids\n']) {
  test(`unavailable root memory controller ${JSON.stringify(controllers)} fails closed`, () => {
    const { data, read } = fixture();
    data.set(`${ROOT}/cgroup.controllers`, controllers);
    data.set(`${ROOT}/cgroup.subtree_control`, '');
    assert.throws(() => memoryHeadroom(read));
  });
}

for (const [name, contents] of [
  ['cgroup.controllers', 'cpu memory:\n'],
  ['cgroup.subtree_control', '+memory\n'],
  ['cgroup.stat', ''],
  ['cgroup.stat', 'nr_descendants 0\n'],
  ['cgroup.stat', 'nr_dying_descendants 0\n'],
  ['cgroup.stat', 'nr_descendants -1\nnr_dying_descendants 0\n'],
  ['cgroup.stat', 'nr_descendants 1.5\nnr_dying_descendants 0\n'],
  ['cgroup.stat', 'nr_descendants 0\nnr_dying_descendants unknown\n'],
  ['cgroup.stat', 'nr_descendants 0 extra\nnr_dying_descendants 0\n'],
  ['cgroup.stat', 'nr_descendants 0\nnr_descendants 1\nnr_dying_descendants 0\n'],
  ['cgroup.stat', 'nr_descendants 0\nnr_dying_descendants 0\nextra_counter nope\n'],
]) {
  test(`malformed root ${name}: ${JSON.stringify(contents)} fails closed`, () => {
    const { data, read } = fixture();
    data.set(`${ROOT}/${name}`, contents);
    assert.throws(() => memoryHeadroom(read));
  });
}

for (const path of ['/parent/job', '/parent']) {
  for (const name of ['memory.max', 'memory.current']) {
    for (const code of ['ENOENT', 'EACCES', 'EIO']) {
      test(`${path}/${name} remains mandatory below a proved root (${code})`, () => {
        const { data, read } = fixture();
        data.set(`${ROOT}${path}/${name}`, fileError(code));
        assert.throws(() => memoryHeadroom(read));
      });
    }
  }
  test(`both absent memory files below the actual root at ${path} cannot be skipped`, () => {
    const { data, read } = fixture();
    data.set(`${ROOT}${path}/memory.max`, fileError('ENOENT'));
    data.set(`${ROOT}${path}/memory.current`, fileError('ENOENT'));
    assert.throws(() => memoryHeadroom(read));
  });
}

for (const [limit, current] of [['unknown', '0'], ['', '0'], ['-1', '0'], ['1.5', '0'], ['1e9', '0'], ['MAX', '0'], ['max', 'max'], ['max', '-1'], ['max', '']]) {
  test(`malformed below-root counters ${JSON.stringify([limit, current])} fail closed`, () => {
    const { read, set } = fixture();
    set('/parent/job', limit, current);
    assert.throws(() => memoryHeadroom(read));
  });
}

test('root v2 membership with no cgroup mount preserves the original no-mount rejection', () => {
  // Conceptual receipt reproduction: membership '/', no matching memory mount.
  // Supplied readable core files cannot rescue missing mount provenance.
  const { data, read } = fixture({ membershipPath: '/' });
  data.set('/proc/self/mountinfo', HOST_MOUNT);
  assert.throws(() => memoryHeadroom(read));
});

test('a subtree-only mount cannot prove hidden ancestors or the actual root', () => {
  assert.throws(() => memoryHeadroom(fixture({ mountRoot: '/parent' }).read));
});

test('a nonmatching cgroup subtree mount cannot prove membership ancestry', () => {
  const { data, read } = fixture();
  data.set('/proc/self/mountinfo', HOST_MOUNT + v2Mount('/different-subtree'));
  assert.throws(() => memoryHeadroom(read));
});

for (const obscured of [ROOT, `${ROOT}/cgroup.controllers`, `${ROOT}/cgroup.type`, `${ROOT}/memory.max`, `${ROOT}/parent`, `${ROOT}/parent/job/memory.current`]) {
  test(`a conflicting mount at ${obscured} defeats observation provenance`, () => {
    const { data, read } = fixture();
    data.set('/proc/self/mountinfo', HOST_MOUNT + v2Mount() +
      `21 20 0:21 / ${escapeMount(obscured)} rw - tmpfs tmpfs rw\n`);
    assert.throws(() => memoryHeadroom(read));
  });
}

test('a child mount outside the observed ancestry does not invalidate proof', () => {
  const { data, read } = fixture();
  data.set('/proc/self/mountinfo', HOST_MOUNT + v2Mount() +
    `21 20 0:21 / ${ROOT}/unrelated rw - tmpfs tmpfs rw\n`);
  assertProvedRoot(memoryHeadroom(read));
});

test('a later strict-ancestor overmount obscures a previously visible cgroup mount', () => {
  const { data, read } = fixture({ mountPoint: '/sys/fs/cgroup' });
  // The cgroup mount is a child of mount 10. Mount 21 is a separate mount
  // over its path prefix, not part of that proved parent-ID chain.
  data.set('/proc/self/mountinfo', HOST_MOUNT + v2Mount('/', '/sys/fs/cgroup') +
    '21 10 0:21 / /sys/fs rw - tmpfs tmpfs rw\n');
  assert.throws(() => memoryHeadroom(read));
});

test('v1 memory membership is rejected even when numeric counters are supplied', () => {
  const { data, read } = fixture();
  data.set('/proc/self/cgroup', '4:cpu,memory:/parent/job\n');
  data.set('/proc/self/mountinfo', HOST_MOUNT + `20 10 0:20 / ${ROOT} rw - cgroup memory rw,memory\n`);
  for (const path of ['', '/parent', '/parent/job']) {
    data.set(`${ROOT}${path}/memory.limit_in_bytes`, '9223372036854771712\n');
    data.set(`${ROOT}${path}/memory.usage_in_bytes`, '0\n');
  }
  assert.throws(() => memoryHeadroom(read));
});

test('hybrid v1-memory and v2 membership cannot silently select v2', () => {
  const { data, read } = fixture();
  data.set('/proc/self/cgroup', '0::/parent/job\n4:cpu,memory:/parent/job\n');
  assert.throws(() => memoryHeadroom(read));
});

test('complete non-memory membership and no memory mounts preserve host-only mode', () => {
  const { data, read } = fixture();
  data.set('/proc/self/cgroup', '2:cpu,cpuacct:/worker\n3:pids:/worker\n');
  data.set('/proc/self/mountinfo', HOST_MOUNT + '21 10 0:21 / /mock/cpu rw - cgroup cpu rw,cpu,cpuacct\n');
  const value = memoryHeadroom(read);
  assert.equal(value.effectiveHeadroomBytes, 8 * GiB);
  assert.equal(value.limitingSource.kind, 'host');
  assert.equal(value.cgroup.mode, 'no-memory-controller-membership');
  assert.deepEqual(value.cgroup.groups, []);
});

for (const mount of [v2Mount(), `20 10 0:20 / ${ROOT} rw - cgroup memory rw,memory\n`]) {
  test(`non-memory membership cannot ignore an exposed ${mount.includes('cgroup2') ? 'v2' : 'v1 memory'} mount`, () => {
    const { data, read } = fixture();
    data.set('/proc/self/cgroup', '2:cpu,cpuacct:/worker\n');
    data.set('/proc/self/mountinfo', HOST_MOUNT + mount);
    assert.throws(() => memoryHeadroom(read));
  });
}

for (const membership of ['', '\n', 'not-a-membership\n', '0::relative\n', '0::/../other\n',
  '0::/parent/job\nmalformed\n', '0::/parent/job\n0::/other\n',
  '0::/parent/job\n0::/parent/job\n', '0:cpu:/parent/job\n', '2::/parent/job\n',
  '2:cpu:/parent/job\n3:memory\n']) {
  test(`missing, malformed, or ambiguous membership ${JSON.stringify(membership)} fails closed`, () => {
    const { data, read } = fixture();
    data.set('/proc/self/cgroup', membership);
    assert.throws(() => memoryHeadroom(read));
  });
}

for (const membership of ['2:cpu,,pids:/worker\n', '2:,cpu:/worker\n', '2:cpu,:/worker\n']) {
  test(`malformed controller tokens cannot establish host-only mode: ${JSON.stringify(membership)}`, () => {
    const { data, read } = fixture();
    data.set('/proc/self/cgroup', membership);
    data.set('/proc/self/mountinfo', HOST_MOUNT);
    assert.throws(() => memoryHeadroom(read));
  });
}

for (const path of ['/proc/meminfo', '/proc/self/cgroup', '/proc/self/mountinfo']) {
  for (const code of ['ENOENT', 'EACCES', 'EIO']) {
    test(`required supplied input ${path} cannot be replaced with assumptions (${code})`, () => {
      const { data, read } = fixture();
      data.set(path, fileError(code));
      assert.throws(() => memoryHeadroom(read));
    });
  }
}

test('malformed mountinfo fails closed despite valid supplied root proof files', () => {
  const { data, read } = fixture();
  data.set('/proc/self/mountinfo', 'not a mountinfo record\n');
  assert.throws(() => memoryHeadroom(read));
});

for (const meminfo of ['MemTotal: 16777216 kB\n', 'MemAvailable: 8388608 kB\n',
  'MemTotal: 16777216 kB\nMemAvailable: -1 kB\n', 'MemTotal: 16777216 kB\nMemAvailable: unknown kB\n']) {
  test(`missing or malformed host fields ${JSON.stringify(meminfo)} fail closed`, () => {
    const { data, read } = fixture();
    data.set('/proc/meminfo', meminfo);
    assert.throws(() => memoryHeadroom(read));
  });
}

test('genuine filesystem ancestors in the mount-ID chain remain observable', () => {
  const { data, read } = fixture({ mountPoint: '/sys/fs/cgroup' });
  data.set('/proc/self/mountinfo', HOST_MOUNT +
    '11 10 0:11 / /sys rw - sysfs sysfs rw\n' +
    '20 11 0:20 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n');
  assertProvedRoot(memoryHeadroom(read));
});

for (const table of [
  HOST_MOUNT + '20 99 0:20 / /mock/cgroup rw - cgroup2 cgroup rw\n',
  HOST_MOUNT + '11 20 0:11 / /mock rw - tmpfs tmpfs rw\n20 11 0:20 / /mock/cgroup rw - cgroup2 cgroup rw\n',
  HOST_MOUNT + '11 10 0:11 / /elsewhere rw - tmpfs tmpfs rw\n20 11 0:20 / /mock/cgroup rw - cgroup2 cgroup rw\n',
]) {
  test(`missing, cyclic, or path-inconsistent mount ancestry fails: ${JSON.stringify(table)}`, () => {
    const { data, read } = fixture();
    data.set('/proc/self/mountinfo', table);
    assert.throws(() => memoryHeadroom(read));
  });
}

for (const mountRoot of ['/../hidden', '/parent/../hidden']) {
  test(`an escaping mount root cannot hide namespace ancestry: ${mountRoot}`, () => {
    assert.throws(() => memoryHeadroom(fixture({ mountRoot }).read));
  });
}
