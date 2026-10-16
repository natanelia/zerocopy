"""Read-only Linux resource accounting. No subprocesses or subject imports.

The effective_memory function is unchanged from the previously public
ordered-checkpoints preparation resource guard. It returns scalar accounting
only; no cgroup paths, mount tables, hostnames or environment are returned.
"""
import os
from pathlib import Path
import re


def require(condition, message):
    if not condition:
        raise ValueError(message)


def effective_memory():
    """Read host headroom and every visible limiting cgroup ancestor."""
    host = {key: int(value) * 1024 for key, value in re.findall(
        r'^(MemTotal|MemAvailable):\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.M)}
    require('MemAvailable' in host and 'MemTotal' in host, 'host memory accounting unavailable')
    memberships = []
    for line in Path('/proc/self/cgroup').read_text().splitlines():
        _, controllers, group = line.split(':', 2)
        controllers = controllers.split(',') if controllers else []
        if not controllers or 'memory' in controllers or 'cpu' in controllers:
            memberships.append((not controllers, group, controllers))
    rows, cpu_rows = [], []
    def unescape(value):
        return re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), value)
    mounts = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left, right = line.split(' - ', 1)
        fields, tail = left.split(), right.split()
        controllers = tail[2].split(',')
        if tail[0] == 'cgroup2' or (tail[0] == 'cgroup' and ('memory' in controllers or 'cpu' in controllers)):
            mounts.append((tail[0] == 'cgroup2', Path(unescape(fields[3])), Path(unescape(fields[4])), controllers))
    for unified, group, controllers in memberships:
        matching = [(root, mount) for version, root, mount, supported in mounts
                    if version == unified and Path(group).is_relative_to(root) and
                    (unified or set(controllers).intersection(supported))]
        require(matching, 'cannot resolve effective resource cgroup')
        root, mount = max(matching, key=lambda item: len(item[0].parts))
        current = mount / Path(group).relative_to(root)
        while True:
            limit_file = current / ('memory.max' if unified else 'memory.limit_in_bytes')
            usage_file = current / ('memory.current' if unified else 'memory.usage_in_bytes')
            if (unified or 'memory' in controllers) and limit_file.exists():
                limit_text = limit_file.read_text().strip()
                usage = int(usage_file.read_text().strip())
                limit = None if limit_text == 'max' else int(limit_text)
                rows.append({'version': 2 if unified else 1, 'limitBytes': limit, 'usageBytes': usage,
                             'availableBytes': None if limit is None else max(0, limit - usage)})
            if unified and (current / 'cpu.max').exists():
                quota, period = (current / 'cpu.max').read_text().split()
                cpu_rows.append({'version': 2, 'quotaMicroseconds': None if quota == 'max' else int(quota),
                                 'periodMicroseconds': int(period)})
            elif not unified and 'cpu' in controllers and (current / 'cpu.cfs_quota_us').exists():
                quota = int((current / 'cpu.cfs_quota_us').read_text())
                cpu_rows.append({'version': 1, 'quotaMicroseconds': None if quota < 0 else quota,
                                 'periodMicroseconds': int((current / 'cpu.cfs_period_us').read_text())})
            require(current.is_relative_to(mount), 'cgroup ancestor escaped mount')
            if current == mount:
                break
            current = current.parent
    available = min([host['MemAvailable']] + [row['availableBytes'] for row in rows
                                            if row['availableBytes'] is not None])
    host_cpus, affinity_cpus = os.cpu_count(), len(os.sched_getaffinity(0))
    return {'host': host, 'cgroups': rows, 'effectiveAvailableBytes': available,
            'effectiveLimitBytes': min([host['MemTotal']] + [row['limitBytes'] for row in rows
                                                           if row['limitBytes'] is not None]),
            'cpu': {'hostLogicalCount': host_cpus, 'affinityCount': affinity_cpus, 'cgroupQuotas': cpu_rows,
                    'effectiveCpuBudget': min([host_cpus, affinity_cpus] +
                        [row['quotaMicroseconds'] / row['periodMicroseconds'] for row in cpu_rows
                         if row['quotaMicroseconds'] is not None])}}
