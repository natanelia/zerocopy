/** Pure v2 headroom parser. All reads are supplied; tests never inspect a host.
 * Root proof follows Linux v6.8 CFTYPE_NOT_ON_ROOT semantics, not namespace names.
 */
import assert from 'node:assert/strict';
import { posix } from 'node:path';

const decodeMount = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
function absolute(value, name) {
  assert.ok(value.startsWith('/'), `${name} is not absolute`);
  assert.ok(!value.split('/').includes('..'), `${name} escapes the visible cgroup namespace`);
  return posix.normalize(value);
}
function numeric(value, label) {
  assert.match(value, /^\d+$/, `Cannot interpret ${label}`);
  return BigInt(value);
}
function readRequired(readText, path) {
  try { return readText(path).trim(); }
  catch (error) { throw new Error(`Cannot observe required memory counter ${path}: ${error.code ?? error.message}; refusing to assume unlimited headroom`, { cause: error }); }
}
function memberships(text) {
  const entries = text.trim().split('\n').filter(Boolean).map(line => {
    const match = /^(\d+):([^:]*):(\/.*)$/.exec(line);
    assert.ok(match, 'Cannot interpret /proc/self/cgroup');
    const controllers = match[2] ? match[2].split(',') : [];
    assert.ok(controllers.every(Boolean), 'Empty cgroup controller token');
    assert.ok(controllers.every(value => /^[a-zA-Z0-9_=.-]+$/.test(value)), 'Malformed cgroup controller');
    assert.equal(new Set(controllers).size, controllers.length, 'Duplicate cgroup controller');
    return { hierarchyId: match[1], controllers, path: absolute(match[3], 'Cgroup membership') };
  });
  assert.ok(entries.length, 'Missing cgroup membership evidence');
  assert.equal(new Set(entries.map(entry => entry.hierarchyId)).size, entries.length, 'Ambiguous cgroup membership');
  for (const entry of entries) {
    assert.ok(entry.hierarchyId !== '0' || entry.controllers.length === 0, 'Malformed v2 cgroup membership');
    assert.ok(entry.hierarchyId === '0' || entry.controllers.length > 0, 'Malformed v1 cgroup membership');
  }
  assert.ok(!entries.some(entry => entry.controllers.includes('memory')), 'Hosted headroom proof supports v2 only; v1 ancestry is not proved');
  return { entries, membership: entries.find(entry => entry.hierarchyId === '0') ?? null };
}
function mounts(text) {
  const values = text.trim().split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf(' - ');
    assert.ok(separator > 0, 'Cannot interpret /proc/self/mountinfo');
    const before = line.slice(0, separator).split(' '), after = line.slice(separator + 3).split(' ');
    assert.ok(before.length >= 6 && after.length >= 3, 'Incomplete mountinfo record');
    assert.match(before[0], /^\d+$/); assert.match(before[1], /^\d+$/);
    const version = after[0] === 'cgroup2' ? 2 : after[0] === 'cgroup' && after[2].split(',').includes('memory') ? 1 : null;
    return { version, mountId: before[0], parentMountId: before[1], filesystem: after[0],
      root: absolute(decodeMount(before[3]), 'Mount root'), point: absolute(decodeMount(before[4]), 'Mount point') };
  });
  assert.ok(values.length, 'Missing mount table evidence');
  assert.equal(new Set(values.map(value => value.mountId)).size, values.length, 'Duplicate mount identity');
  return values;
}
const within = (path, directory) => path === directory || path.startsWith(directory === '/' ? '/' : directory + '/');
function controllerNames(text, name) {
  const names = text ? text.split(/\s+/) : [];
  assert.ok(names.every(value => /^[a-z][a-z0-9_]*$/.test(value)), `Malformed ${name}`);
  assert.equal(new Set(names).size, names.length, `Duplicate ${name}`);
  return names;
}
function rootStatistics(text) {
  const entries = text.split('\n').map(line => {
    const match = /^([a-z][a-z0-9_]*)\s+(\d+)$/.exec(line);
    assert.ok(match, 'Malformed cgroup.stat');
    numeric(match[2], 'cgroup.stat');
    return [match[1], match[2]];
  });
  assert.equal(new Set(entries.map(([name]) => name)).size, entries.length, 'Duplicate cgroup.stat field');
  const result = Object.fromEntries(entries);
  assert.ok(Object.hasOwn(result, 'nr_descendants') && Object.hasOwn(result, 'nr_dying_descendants'), 'Missing cgroup.stat root fields');
  return result;
}

export function memoryHeadroom(readText) {
  assert.equal(typeof readText, 'function');
  const meminfo = readRequired(readText, '/proc/meminfo');
  const hostField = name => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(meminfo);
    assert.ok(match, `Missing host ${name}`);
    const bytes = numeric(match[1], name) * 1024n;
    assert.ok(bytes <= BigInt(Number.MAX_SAFE_INTEGER), `${name} exceeds safe receipt precision`);
    return Number(bytes);
  };
  const totalBytes = hostField('MemTotal'), availableBytes = hostField('MemAvailable');
  const complete = memberships(readRequired(readText, '/proc/self/cgroup'));
  const allMounts = mounts(readRequired(readText, '/proc/self/mountinfo'));
  const memoryMounts = allMounts.filter(mount => mount.version !== null);
  assert.ok(!memoryMounts.some(mount => mount.version === 1), 'Hosted headroom proof supports v2 only; v1 mount ancestry is not proved');
  const membership = complete.membership;
  const hostSource = { kind: 'host', path: '/proc/meminfo', field: 'MemAvailable', headroomBytes: String(availableBytes) };
  if (!membership) {
    assert.equal(memoryMounts.length, 0, 'Memory cgroup mount exists without resolvable own membership');
    return { totalBytes, availableBytes, effectiveHeadroomBytes: availableBytes, limitingSource: hostSource,
      cgroup: { mode: 'no-memory-controller-membership', memberships: complete.entries, groups: [] } };
  }
  const candidates = memoryMounts.filter(mount => mount.version === 2 && within(membership.path, mount.root));
  const mount = candidates.filter(value => value.root === '/').sort((left, right) => left.point.length - right.point.length)[0];
  if (!mount) {
    const error = new Error('Cannot observe the own memory cgroup and all applicable ancestor groups from a hierarchy-root mount');
    error.memoryObservation = { state: 'unresolvable-hierarchy', membership: { ...membership, version: 2 }, mounts: memoryMounts, host: { totalBytes, availableBytes } };
    throw error;
  }
  // Mount paths alone cannot prove visibility: an ancestor overmount can hide a
  // still-listed child mount. Establish actual ancestry by mount IDs first.
  const byMountId = new Map(allMounts.map(value => [value.mountId, value]));
  const mountAncestry = new Set();
  for (let cursor = mount; ; ) {
    assert.ok(!mountAncestry.has(cursor.mountId), 'Cycle in cgroup mount ancestry');
    mountAncestry.add(cursor.mountId);
    const parent = byMountId.get(cursor.parentMountId);
    if (!parent || parent.mountId === cursor.mountId) {
      assert.equal(cursor.point, '/', 'Incomplete cgroup mount ancestry above visible filesystem root');
      break;
    }
    assert.ok(within(cursor.point, parent.point), 'Inconsistent cgroup mount ancestry');
    cursor = parent;
  }
  function unobscured(path) {
    const conflicts = allMounts.filter(other => !mountAncestry.has(other.mountId) && within(path, other.point));
    if (conflicts.length) {
      const error = new Error(`A conflicting mount obscures the cgroup root or required observation: ${path}`);
      error.memoryObservation = { state: 'obscured-hierarchy', path, mount, conflicts };
      throw error;
    }
  }
  unobscured(mount.point);
  const rootReads = {}, rootFailures = [];
  // All these files are on the proved cgroup2 root mount, without an overlay.
  for (const name of ['cgroup.controllers', 'cgroup.subtree_control', 'cgroup.stat', 'cgroup.type', 'cgroup.events', 'memory.max', 'memory.current']) {
    const path = posix.join(mount.point, name); unobscured(path);
    try { rootReads[name] = { path, value: readText(path).trim() }; }
    catch (error) { rootFailures.push({ name, path, code: error.code ?? null, message: error.message }); }
  }
  let rootProof;
  try {
    const required = ['cgroup.controllers', 'cgroup.subtree_control', 'cgroup.stat'];
    assert.ok(required.every(name => Object.hasOwn(rootReads, name)), 'Missing required core files for cgroup root proof');
    const absent = ['cgroup.type', 'cgroup.events', 'memory.max', 'memory.current'];
    assert.ok(absent.every(name => !Object.hasOwn(rootReads, name) && rootFailures.some(failure => failure.name === name && failure.code === 'ENOENT')),
      'Unproved or namespace cgroup root: type/events and memory interfaces must all be absent with ENOENT');
    assert.equal(rootFailures.length, absent.length, 'Restricted or unavailable cgroup root proof');
    const controllers = controllerNames(rootReads['cgroup.controllers'].value, 'cgroup.controllers');
    assert.ok(controllers.includes('memory'), 'Memory controller is unavailable at the cgroup root');
    const subtreeControl = controllerNames(rootReads['cgroup.subtree_control'].value, 'cgroup.subtree_control');
    assert.ok(subtreeControl.every(name => controllers.includes(name)), 'Unknown enabled root controller');
    const statistics = rootStatistics(rootReads['cgroup.stat'].value);
    rootProof = { status: 'proved-actual-v2-root', method: 'Readable cgroup2 core files plus CFTYPE_NOT_ON_ROOT type/events absence; memory interfaces absent; no obscuring mounts',
      directory: mount.point, mountAncestry: [...mountAncestry], controllers, subtreeControl, statistics, reads: rootReads, absent: rootFailures };
  } catch (error) {
    error.memoryObservation = { state: 'unproved-root', membershipPath: membership.path, mount, rootReads, rootFailures, host: { totalBytes, availableBytes } };
    throw error;
  }
  const groups = [];
  let effective = BigInt(availableBytes), limitingSource = hostSource;
  for (let hierarchyPath = membership.path; ; hierarchyPath = posix.dirname(hierarchyPath)) {
    const directory = posix.join(mount.point, hierarchyPath.slice(1)); unobscured(directory);
    if (hierarchyPath === '/') {
      groups.push({ hierarchyPath, directory, limitKind: 'proved-unconstrained-root', rootProof });
      break;
    }
    const limitPath = posix.join(directory, 'memory.max'), currentPath = posix.join(directory, 'memory.current');
    const values = {}, failures = [];
    for (const [field, path] of [['limit', limitPath], ['current', currentPath]]) {
      unobscured(path);
      try { values[field] = readText(path).trim(); }
      catch (error) { failures.push({ field, path, code: error.code ?? null, message: error.message }); }
    }
    if (failures.length) {
      const error = new Error(`Cannot observe required memory counter(s) ${failures.map(failure => `${failure.path} (${failure.code ?? failure.message})`).join(', ')}; refusing to assume unlimited headroom`);
      error.memoryObservation = { state: 'unobservable-counter', version: 2, membershipPath: membership.path, mount, hierarchyPath, values, failures,
        rootProof, observedGroups: groups, host: { totalBytes, availableBytes } };
      throw error;
    }
    let current, limit;
    try {
      current = numeric(values.current, currentPath);
      limit = values.limit === 'max' ? null : numeric(values.limit, limitPath);
    } catch (error) {
      error.memoryObservation = { state: 'malformed-counter', version: 2, membershipPath: membership.path, mount, hierarchyPath, limitPath, currentPath, values,
        rootProof, observedGroups: groups, host: { totalBytes, availableBytes } };
      throw error;
    }
    const headroom = limit === null ? null : limit > current ? limit - current : 0n;
    const group = { hierarchyPath, directory, limitPath, currentPath, limitKind: limit === null ? 'explicit-unlimited' : 'numeric-hard-limit',
      limitBytes: limit?.toString() ?? null, currentBytes: current.toString(), headroomBytes: headroom?.toString() ?? null };
    groups.push(group);
    if (headroom !== null && headroom < effective) {
      effective = headroom;
      limitingSource = { kind: 'cgroup-v2', hierarchyPath, limitPath, currentPath, limitBytes: limit.toString(), currentBytes: current.toString(), headroomBytes: headroom.toString() };
    }
  }
  return { totalBytes, availableBytes, effectiveHeadroomBytes: Number(effective), limitingSource,
    cgroup: { version: 2, membershipPath: membership.path, mountId: mount.mountId, mountRoot: mount.root, mountPoint: mount.point, rootProof,
      ancestry: 'Own group through proved actual hierarchy root, inclusive; namespace, subtree-only, obscured or unreadable ancestry is rejected.', groups } };
}
