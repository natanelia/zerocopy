"""Root-first package checks and bounded, identity-bound cleanup of two temp roots."""
import hashlib
import json
import os
from pathlib import Path
import stat
import time

from bounded_process import require, write

MAX_ENTRIES = 512
MAX_DEPTH = 8
MAX_METADATA_BYTES = 128 * 1024
SCAN_SECONDS = 5
CLEANUP_SECONDS = 10
PLAN_ENTRIES = 8192
PLAN_BYTES = 2 * 1024 * 1024
JOURNAL_BYTES = 2 * 1024 * 1024
RECORD_BYTES = 16 * 1024
FLUSH_BYTES = 64 * 1024
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def encoded(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':')) + '\n').encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def check_time(stop):
    require(time.monotonic() < stop, 'Temporary accounting deadline')


def identity(info):
    return info.st_dev, info.st_ino


def create_scope(path):
    path = Path(path)
    path.mkdir(mode=0o700)
    return {'path': path, 'identity': identity(path.stat(follow_symlinks=False))}


def open_scope(scope):
    descriptor = os.open(scope['path'], DIRECTORY_FLAGS)
    if identity(os.fstat(descriptor)) != scope['identity']:
        os.close(descriptor)
        raise ValueError('Temporary scope root identity changed')
    return descriptor


def kind(mode):
    if stat.S_ISDIR(mode): return 'directory'
    if stat.S_ISREG(mode): return 'file'
    if stat.S_ISLNK(mode): return 'symlink'
    return 'special'


def metadata(entry, prefix=''):
    info = entry.stat(follow_symlinks=False)
    row = {'name': prefix + entry.name, 'type': kind(info.st_mode), 'sizeBytes': info.st_size,
           'device': info.st_dev, 'inode': info.st_ino}
    require(row['type'] != 'special', 'Temporary special entry is unsupported')
    return row


def open_child(descriptor, name, row):
    child = os.open(name, DIRECTORY_FLAGS, dir_fd=descriptor)
    if identity(os.fstat(child)) != (row['device'], row['inode']):
        os.close(child)
        raise ValueError('Temporary ancestor identity changed')
    return child


def top_entries(scope, stop):
    stop = min(stop, time.monotonic() + SCAN_SECONDS)
    descriptor = open_scope(scope)
    rows, size = [], 0
    try:
        with os.scandir(descriptor) as listing:
            for entry in listing:
                check_time(stop)
                require(len(rows) < MAX_ENTRIES, 'Temporary root entry cap')
                row = metadata(entry)
                size += len(encoded(row))
                require(size <= MAX_METADATA_BYTES, 'Temporary root metadata byte cap')
                rows.append(row)
        require(identity(scope['path'].stat(follow_symlinks=False)) == scope['identity'], 'Temporary root replaced during scan')
    finally:
        os.close(descriptor)
    rows.sort(key=lambda row: row['name'])
    check_time(stop)
    return rows, size


class SampleFull(Exception):
    pass


def snapshot(scope, deadline):
    stop = min(deadline, time.monotonic() + SCAN_SECONDS)
    result = {'entries': [], 'complete': False, 'rootCoverageComplete': False,
              'descendantSampleComplete': False, 'metadataBytes': 0,
              'limits': {'entries': MAX_ENTRIES, 'depth': MAX_DEPTH,
                         'metadataBytes': MAX_METADATA_BYTES, 'seconds': SCAN_SECONDS}}
    def visit(descriptor, prefix, depth):
        with os.scandir(descriptor) as listing:
            for entry in listing:
                if time.monotonic() >= stop - .1: raise SampleFull('diagnostic time reserve')
                if len(result['entries']) >= MAX_ENTRIES: raise SampleFull('diagnostic entry cap')
                require(depth <= MAX_DEPTH, 'Temporary metadata depth cap')
                row = metadata(entry, prefix)
                size = len(encoded(row))
                if result['metadataBytes'] + size > MAX_METADATA_BYTES: raise SampleFull('diagnostic byte cap')
                result['entries'].append(row)
                result['metadataBytes'] += size
                if row['type'] == 'directory':
                    child = open_child(descriptor, entry.name, row)
                    try: visit(child, row['name'] + '/', depth + 1)
                    finally: os.close(child)
    try:
        roots, size = top_entries(scope, stop)
        result.update(entries=list(roots), metadataBytes=size, rootCoverageComplete=True, rootEntryCount=len(roots))
        descriptor = open_scope(scope)
        try:
            for row in roots:
                if row['type'] == 'directory':
                    child = open_child(descriptor, row['name'], row)
                    try: visit(child, row['name'] + '/', 2)
                    finally: os.close(child)
            result['descendantSampleComplete'] = True
        except SampleFull as error:
            result['truncationReason'] = str(error)
        finally:
            os.close(descriptor)
        result['entries'].sort(key=lambda row: row['name'])
        check_time(stop)
        result['complete'] = True
    except (OSError, ValueError) as error:
        result['error'] = str(error) if isinstance(error, ValueError) else type(error).__name__
    result['retainedCount'] = len(result['entries'])
    return result


def package_workspaces_absent(observation):
    require(observation['complete'] and observation['rootCoverageComplete'], 'Package root inventory incomplete')
    require(not any('/' not in row['name'] and row['name'].startswith('zerocopy-package-')
                    for row in observation['entries']), 'Package-prefixed temporary entry remains before cleanup')


def prefix_proof(scope, stop):
    rows, size = top_entries(scope, stop)
    observation = {'complete': True, 'rootCoverageComplete': True, 'entries': rows, 'metadataBytes': size}
    package_workspaces_absent(observation)
    return observation


def verify_plan(plan, stop):
    stream = plan['stream']
    require(identity(plan['path'].stat(follow_symlinks=False)) == plan['identity'] == identity(os.fstat(stream.fileno())), 'Temporary plan identity changed')
    require(os.fstat(stream.fileno()).st_size == plan['bytes'], 'Temporary plan size changed')
    stream.seek(0)
    value = hashlib.sha256()
    remaining = plan['bytes']
    require(0 <= remaining <= PLAN_BYTES, 'Temporary plan verification byte cap')
    while remaining:
        check_time(stop)
        block = stream.read(min(RECORD_BYTES, remaining))
        require(block, 'Temporary plan shortened during verification')
        value.update(block)
        remaining -= len(block)
    require(not stream.read(1) and os.fstat(stream.fileno()).st_size == plan['bytes'] and
            value.hexdigest() == plan['sha256'], 'Temporary plan digest/size changed')
    stream.seek(0)
    check_time(stop)


def verify_pair(path, expected_identity, data, stop):
    require(len(data) <= 4096, 'Temporary pair completion byte cap')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and identity(info) == expected_identity and info.st_size == len(data),
                'Temporary pair completion identity/size changed')
        require(os.read(descriptor, len(data) + 1) == data and
                identity(path.stat(follow_symlinks=False)) == expected_identity, 'Temporary pair completion changed')
    finally:
        os.close(descriptor)
    check_time(stop)


def verify_journal(stream, path, expected_identity, size, expected_digest, stop):
    info = os.fstat(stream.fileno())
    require(stat.S_ISREG(info.st_mode) and identity(info) == expected_identity ==
            identity(path.stat(follow_symlinks=False)) and info.st_size == size, 'Temporary journal identity/size changed')
    stream.seek(0)
    value = hashlib.sha256()
    require(0 <= size <= JOURNAL_BYTES, 'Temporary journal verification byte cap')
    remaining = size
    while remaining:
        check_time(stop)
        block = stream.read(min(RECORD_BYTES, remaining))
        require(block, 'Temporary journal shortened during verification')
        value.update(block)
        remaining -= len(block)
    require(not stream.read(1) and os.fstat(stream.fileno()).st_size == size and
            value.hexdigest() == expected_digest and identity(path.stat(follow_symlinks=False)) == expected_identity,
            'Temporary journal digest/identity changed')
    check_time(stop)


def make_plan(name, scope, before, path, budget, stop):
    stream = path.open('x+b', buffering=0)
    hashes, value = bytearray(), hashlib.sha256()
    count, size = 0, 0
    def append(row, reserve=6144):
        nonlocal size
        data = encoded(row)
        require(len(data) <= RECORD_BYTES, 'Temporary plan record byte cap')
        require(budget['bytes'] + len(data) + reserve <= PLAN_BYTES, 'Temporary aggregate plan byte cap')
        require(stream.write(data) == len(data), 'Temporary plan short write')
        hashes.extend(hashlib.sha256(data).digest())
        value.update(data)
        size += len(data); budget['bytes'] += len(data)
    def visit(descriptor, prefix, ancestors, depth):
        nonlocal count
        with os.scandir(descriptor) as listing:
            for entry in listing:
                check_time(stop)
                require(depth <= MAX_DEPTH, 'Temporary plan depth cap')
                require(budget['entries'] < PLAN_ENTRIES, 'Temporary aggregate plan entry cap')
                row = metadata(entry, prefix)
                budget['entries'] += 1; count += 1
                if row['type'] == 'directory':
                    child = open_child(descriptor, entry.name, row)
                    try: visit(child, row['name'] + '/', ancestors + [[row['device'], row['inode']]], depth + 1)
                    finally: os.close(child)
                append({'kind': 'entry', 'scope': name, **row, 'ancestors': ancestors})
    try:
        append({'kind': 'header', 'scope': name, 'rootIdentity': list(scope['identity']), 'rootInventorySHA256': digest(before['entries'])})
        descriptor = open_scope(scope)
        try: visit(descriptor, '', [], 1)
        finally: os.close(descriptor)
        append({'kind': 'complete', 'entryCount': count, 'precedingBytes': size, 'precedingSHA256': value.hexdigest()}, reserve=4096)
        stream.flush(); os.fsync(stream.fileno()); check_time(stop)
        plan = {'path': path, 'stream': stream, 'identity': identity(os.fstat(stream.fileno())),
                'hashes': hashes, 'sha256': value.hexdigest(), 'bytes': size, 'entries': count}
        verify_plan(plan, stop)
        return plan
    except BaseException:
        stream.close()
        raise


def remove_record(scope, row):
    parts = row['name'].split('/')
    require(all(part not in ('', '.', '..') for part in parts) and len(parts) <= MAX_DEPTH and
            len(row['ancestors']) == len(parts) - 1, 'Unsafe temporary plan path')
    parent = open_scope(scope)
    try:
        for part, expected in zip(parts[:-1], row['ancestors']):
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=parent)
            try:
                require(identity(os.fstat(child)) == tuple(expected), 'Temporary ancestor identity changed')
            except BaseException:
                os.close(child); raise
            os.close(parent); parent = child
        current = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        require((current.st_dev, current.st_ino, kind(current.st_mode)) ==
                (row['device'], row['inode'], row['type']), 'Temporary entry identity changed')
        if row['type'] == 'directory': os.rmdir(parts[-1], dir_fd=parent)
        else:
            require(row['type'] in ('file', 'symlink'), 'Temporary special entry is unsupported')
            os.unlink(parts[-1], dir_fd=parent)
    finally:
        os.close(parent)


def cleanup_scopes(scopes, output, deadline, processes_closed):
    stop = min(deadline, time.monotonic() + CLEANUP_SECONDS)
    planning_stop = min(stop, time.monotonic() + SCAN_SECONDS)
    output = Path(output); output.mkdir()
    receipt_path = output / 'receipt.json'
    receipt = {'complete': False, 'processesClosed': processes_closed,
               'limits': {'entries': PLAN_ENTRIES, 'planBytes': PLAN_BYTES, 'journalBytes': JOURNAL_BYTES,
                          'depth': MAX_DEPTH, 'planningSeconds': SCAN_SECONDS, 'cleanupSeconds': CLEANUP_SECONDS}}
    plans, journal = {}, None
    budget = {'entries': 0, 'bytes': 0}
    journal_bytes = journal_buffer = deleted = 0
    journal_hash = hashlib.sha256()
    def flush_journal():
        nonlocal journal_buffer
        journal.flush(); os.fsync(journal.fileno()); check_time(stop)
        journal_buffer = 0
    def emit(data):
        nonlocal journal_bytes, journal_buffer
        require(journal.write(data) == len(data), 'Temporary journal short write')
        journal_hash.update(data)
        journal_bytes += len(data); journal_buffer += len(data)
        if journal_buffer >= FLUSH_BYTES: flush_journal()
    def journal_record(row, reserve=1024):
        data = encoded(row)
        require(len(data) <= RECORD_BYTES and journal_bytes + len(data) + reserve <= JOURNAL_BYTES,
                'Temporary journal byte cap')
        return data
    write(receipt_path, receipt)
    try:
        check_time(planning_stop)
        require(processes_closed and set(scopes) == {'shared', 'package'}, 'Closed groups and both temporary scopes required')
        before = {name: prefix_proof(scopes[name], planning_stop) for name in ['shared', 'package']}
        for name in ['shared', 'package']:
            plans[name] = make_plan(name, scopes[name], before[name], output / (name + '-plan.jsonl'), budget, planning_stop)
        bindings = {name: {'file': plan['path'].name, 'identity': list(plan['identity']), 'sha256': plan['sha256'],
                          'entries': plan['entries'], 'bytes': plan['bytes']} for name, plan in plans.items()}
        pair = {'complete': True, 'plans': bindings, 'aggregateEntries': budget['entries'],
                'aggregateBytes': budget['bytes'], 'orderedBindingsSHA256': digest(bindings)}
        for _ in range(8):
            size = budget['bytes'] + len(encoded(pair))
            if pair['aggregateBytes'] == size: break
            pair['aggregateBytes'] = size
        require(size == pair['aggregateBytes'] and size <= PLAN_BYTES, 'Temporary plan completion byte cap')
        pair_path = output / 'plans-complete.json'
        with pair_path.open('xb') as stream:
            stream.write(encoded(pair)); stream.flush(); os.fsync(stream.fileno())
            pair_identity = identity(os.fstat(stream.fileno()))
        pair_sha = hashlib.sha256(encoded(pair)).hexdigest()
        check_time(planning_stop)
        for plan in plans.values(): verify_plan(plan, planning_stop)
        rechecked = {name: prefix_proof(scopes[name], stop) for name in ['shared', 'package']}
        require(all(rechecked[name]['entries'] == before[name]['entries'] for name in scopes), 'Temporary root entries changed after planning')
        verify_pair(pair_path, pair_identity, encoded(pair), stop)
        receipt['plans'] = pair
        journal_path = output / 'deleted.jsonl'
        journal = journal_path.open('x+b', buffering=0)
        journal_identity = identity(os.fstat(journal.fileno()))
        emit(journal_record({'kind': 'header', 'planPairSHA256': pair_sha,
             'rootProofs': {name: {'rootIdentity': list(scopes[name]['identity']), 'rootCoverageComplete': True,
                           'packagePrefixAbsent': True, 'inventorySHA256': digest(rechecked[name]['entries'])} for name in scopes}}))
        flush_journal()
        for name, plan in plans.items():
            verify_plan(plan, stop)
            index = entries = 0
            while data := plan['stream'].readline(RECORD_BYTES + 1):
                check_time(stop)
                require(len(data) <= RECORD_BYTES and data.endswith(b'\n') and
                        hashlib.sha256(data).digest() == plan['hashes'][index * 32:(index + 1) * 32], 'Temporary plan record changed')
                row = json.loads(data)
                if row['kind'] == 'entry':
                    require(row['scope'] == name, 'Temporary plan scope changed')
                    acknowledgment = journal_record({'kind': 'deleted', 'scope': name, 'recordIndex': index,
                                                     'name': row['name'], 'type': row['type']})
                    remove_record(scopes[name], row)
                    emit(acknowledgment)
                    entries += 1; deleted += 1
                else:
                    require((index == 0 and row['kind'] == 'header') or row['kind'] == 'complete', 'Temporary plan record kind')
                index += 1
            require(index * 32 == len(plan['hashes']) and entries == plan['entries'], 'Temporary plan replay incomplete')
            verify_plan(plan, stop)
        emit(journal_record({'kind': 'replay-complete', 'deletedEntries': deleted, 'precedingSHA256': journal_hash.hexdigest()}, reserve=0))
        flush_journal()
        after = {name: {'entries': top_entries(scope, stop)[0], 'rootCoverageComplete': True} for name, scope in scopes.items()}
        write(output / 'empty-after.json', after); check_time(stop)
        require(all(not row['entries'] for row in after.values()), 'Temporary scope not empty after cleanup')
        verify_pair(pair_path, pair_identity, encoded(pair), stop)
        require(deleted == budget['entries'], 'Temporary deletion count mismatch')
        verify_journal(journal, journal_path, journal_identity, journal_bytes, journal_hash.hexdigest(), stop)
        receipt.update(complete=True, deletedEntries=deleted, planPairSHA256=pair_sha,
                       journal={'bytes': journal_bytes, 'sha256': journal_hash.hexdigest(),
                                'confirmedAcknowledgments': deleted, 'durablyClosed': True},
                       emptyAfterVerified=True)
        check_time(stop)
    except BaseException as error:
        receipt.update(complete=False, error=str(error) if isinstance(error, ValueError) else type(error).__name__,
                       confirmedAcknowledgments=deleted, journalBytes=journal_bytes, uncertainTailPossible=True)
        raise
    finally:
        if journal is not None: journal.close()
        for plan in plans.values(): plan['stream'].close()
        if time.monotonic() >= stop:
            receipt.update(complete=False, error='Temporary cleanup deadline including evidence')
        write(receipt_path, receipt)
    if time.monotonic() >= stop:
        receipt.update(complete=False, error='Temporary final receipt exceeded deadline')
        write(receipt_path, receipt)
        raise ValueError('Temporary final receipt exceeded deadline')
    require(receipt['complete'], 'Temporary cleanup incomplete')
    return receipt
