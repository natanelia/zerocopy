"""Bounded metadata and cleanup for this controller's two fresh temp scopes."""
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
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def create_scope(path):
    path = Path(path)
    path.mkdir(mode=0o700)
    identity = path.stat(follow_symlinks=False)
    return {'path': path, 'identity': (identity.st_dev, identity.st_ino)}


def open_scope(scope):
    descriptor = os.open(scope['path'], DIRECTORY_FLAGS)
    identity = os.fstat(descriptor)
    if (identity.st_dev, identity.st_ino) != scope['identity']:
        os.close(descriptor)
        raise ValueError('Temporary scope root identity changed')
    return descriptor


def kind(mode):
    if stat.S_ISDIR(mode): return 'directory'
    if stat.S_ISREG(mode): return 'file'
    if stat.S_ISLNK(mode): return 'symlink'
    return 'special'


def snapshot(scope, deadline):
    stop = min(deadline, time.monotonic() + SCAN_SECONDS)
    result = {'entries': [], 'complete': False, 'metadataBytes': 0,
              'limits': {'entries': MAX_ENTRIES, 'depth': MAX_DEPTH,
                         'metadataBytes': MAX_METADATA_BYTES, 'seconds': SCAN_SECONDS}}

    def visit(descriptor, prefix, depth):
        require(time.monotonic() < stop, 'Temporary metadata deadline')
        with os.scandir(descriptor) as listing:
            for entry in listing:
                require(time.monotonic() < stop, 'Temporary metadata deadline')
                require(len(result['entries']) < MAX_ENTRIES, 'Temporary metadata entry cap')
                require(depth <= MAX_DEPTH, 'Temporary metadata depth cap')
                info = entry.stat(follow_symlinks=False)
                row = {'name': prefix + entry.name, 'type': kind(info.st_mode), 'sizeBytes': info.st_size,
                       'device': info.st_dev, 'inode': info.st_ino}
                size = len(json.dumps(row, ensure_ascii=True, separators=(',', ':')).encode()) + 1
                require(result['metadataBytes'] + size <= MAX_METADATA_BYTES, 'Temporary metadata byte cap')
                result['entries'].append(row)
                result['metadataBytes'] += size
                require(row['type'] != 'special', 'Temporary special entry is unsupported')
                if row['type'] == 'directory':
                    child = os.open(entry.name, DIRECTORY_FLAGS, dir_fd=descriptor)
                    try:
                        opened = os.fstat(child)
                        require((opened.st_dev, opened.st_ino) == (info.st_dev, info.st_ino), 'Temporary directory identity changed')
                        visit(child, row['name'] + '/', depth + 1)
                    finally:
                        os.close(child)

    try:
        descriptor = open_scope(scope)
        try:
            visit(descriptor, '', 1)
        finally:
            os.close(descriptor)
        require(time.monotonic() < stop, 'Temporary metadata deadline')
        result['complete'] = True
    except (OSError, ValueError) as error:
        result['error'] = str(error) if isinstance(error, ValueError) else type(error).__name__
    result['entries'].sort(key=lambda row: row['name'])
    if result['complete'] and time.monotonic() >= stop:
        result.update(complete=False, error='Temporary metadata deadline after sorting')
    return result


def package_workspaces_absent(observation):
    require(observation['complete'], 'Package temporary inventory incomplete')
    require(not any('/' not in row['name'] and row['name'].startswith('zerocopy-package-')
                    for row in observation['entries']), 'Package-prefixed temporary entry remains before cleanup')


def cleanup_scope(scope, receipt_path, deadline, processes_closed, package=False):
    stop = min(deadline, time.monotonic() + CLEANUP_SECONDS)
    receipt = {'complete': False, 'processesClosed': processes_closed, 'packageScope': package,
               'secondsLimit': CLEANUP_SECONDS, 'before': snapshot(scope, stop), 'deleted': []}
    write(receipt_path, receipt)
    try:
        require(processes_closed, 'Temporary cleanup requires closed owned process groups')
        require(receipt['before']['complete'], 'Temporary cleanup inventory incomplete')
        package_workspaces_absent(receipt['before'])
        descriptor = open_scope(scope)
        try:
            for row in sorted(receipt['before']['entries'], key=lambda item: (item['name'].count('/'), item['name']), reverse=True):
                require(time.monotonic() < stop, 'Temporary cleanup deadline')
                parts = row['name'].split('/')
                require(all(part not in {'', '.', '..'} for part in parts), 'Unsafe temporary relative name')
                parent = os.dup(descriptor)
                try:
                    for part in parts[:-1]:
                        child = os.open(part, DIRECTORY_FLAGS, dir_fd=parent)
                        os.close(parent)
                        parent = child
                    current = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                    require((current.st_dev, current.st_ino, kind(current.st_mode)) ==
                            (row['device'], row['inode'], row['type']), 'Temporary entry identity changed')
                    if row['type'] == 'directory':
                        os.rmdir(parts[-1], dir_fd=parent)
                    else:
                        require(row['type'] in {'file', 'symlink'}, 'Temporary special entry is unsupported')
                        os.unlink(parts[-1], dir_fd=parent)
                finally:
                    os.close(parent)
                receipt['deleted'].append({'name': row['name'], 'type': row['type']})
                write(receipt_path, receipt)
        finally:
            os.close(descriptor)
        receipt['after'] = snapshot(scope, stop)
        require(receipt['after']['complete'] and not receipt['after']['entries'], 'Temporary scope not empty after cleanup')
        require(time.monotonic() < stop, 'Temporary cleanup deadline')
        receipt['complete'] = True
    except BaseException as error:
        receipt['error'] = str(error) if isinstance(error, ValueError) else type(error).__name__
        raise
    finally:
        write(receipt_path, receipt)
    if time.monotonic() >= stop:
        receipt.update(complete=False, error='Temporary cleanup evidence deadline')
        write(receipt_path, receipt)
        raise ValueError('Temporary cleanup evidence deadline')
    return receipt
