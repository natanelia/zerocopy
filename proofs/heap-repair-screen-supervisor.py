#!/usr/bin/env python3
"""One subject's Linux subreaper. No browser flags or workload code are changed."""
import ctypes, hashlib, json, os, selectors, signal, subprocess, sys, time
from pathlib import Path

request_path = Path(sys.argv[1])
request = json.loads(request_path.read_text())
receipt_path = Path(request['receiptPath'])
assert not receipt_path.exists(), 'Never replace a native lifetime receipt'
started = time.monotonic()
record = {'schema': 1, 'status': None, 'signal': None, 'error': None, 'timedOut': False,
          'interrupted': None, 'supervisorPid': os.getpid(), 'ownerPid': None,
          'nativeScope': request['nativeScope'], 'checkpoints': [], 'observed': [], 'events': [],
          'infrastructure': {'python': sys.version, 'executable': os.path.realpath(sys.executable),
            'executableSha256': hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest(),
            'sourceSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'hostLibraries': 'Python/libc and host libraries are outside Firefox distribution provenance'}}

def persist():
    temporary = receipt_path.with_suffix(receipt_path.suffix + '.pending')
    temporary.write_text(json.dumps(record, indent=2) + '\n')
    os.replace(temporary, receipt_path)

def table():
    rows = {}
    for name in os.listdir('/proc'):
        if not name.isdigit(): continue
        try:
            stat = Path('/proc', name, 'stat').read_text()
            fields = stat[stat.rfind(')') + 2:].split()
            rows[int(name)] = {'pid': int(name), 'state': fields[0], 'ppid': int(fields[1]),
                'pgid': int(fields[2]), 'session': int(fields[3]), 'startTicks': fields[19]}
        except (FileNotFoundError, ProcessLookupError): pass
    return rows

def live(row): return row['state'] not in ('Z', 'X')
def key(row): return str(row['pid']) + ':' + row['startTicks']
owned = {}

def scoped_rows(rows):
    ids = {os.getpid()}
    # New ownership requires a live ancestry path to this subreaper.
    # Never walk through an absent historical PID that could have been reused.
    while True:
        before = len(ids)
        for row in rows.values():
            if row['ppid'] in ids: ids.add(row['pid'])
        if len(ids) == before: break
    # A registered identity stays ours after reparenting, only for the same birth.
    return [row for row in rows.values() if live(row) and row['pid'] != os.getpid()
            and (row['pid'] in ids or key(row) in owned)]

def observe():
    rows = table()
    for row in scoped_rows(rows):
        k = key(row)
        if k in owned: continue
        identity = {**row, 'executable': None, 'executableSha256': None, 'native': False,
            'ownership': 'descendant of this dedicated subreaper or retained PID/start-tick identity'}
        owned[k] = identity
        record['observed'].append(identity)
        try:
            executable = os.path.realpath('/proc/%s/exe' % row['pid'])
            data = Path('/proc/%s/exe' % row['pid']).read_bytes()
            identity.update(executable=executable, executableSha256=hashlib.sha256(data).hexdigest(),
                native=executable.startswith(request['nativeScope']['root'] + os.sep))
        except (FileNotFoundError, ProcessLookupError):
            identity['observation'] = 'Exited after ownership observation, before executable read'
    return rows

def signal_owned(row):
    # pidfd binds the exact process lifetime, avoiding a PID-reuse kill race.
    try:
        fd = os.pidfd_open(row['pid'])
        try:
            current = table().get(row['pid'])
            if current is None or key(current) != key(row) or not live(current): return False
            signal.pidfd_send_signal(fd, signal.SIGKILL)
            record['events'].append({'kind': 'kill-owned-pidfd', 'pid': row['pid'], 'pgid': row['pgid'], 'startTicks': row['startTicks']})
            return True
        finally: os.close(fd)
    except (ProcessLookupError, FileNotFoundError): return False

def reap():
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
            if pid == 0: return
            record['events'].append({'kind': 'reaped-descendant', 'pid': pid, 'waitStatus': status})
        except ChildProcessError: return

def cleanup_verified(owner_returncode, clear_observations, survivors, group_live):
    return owner_returncode is not None and clear_observations >= 2 and not survivors and not group_live

def cleanup(owner):
    end = time.monotonic() + request['cleanupTimeoutMs'] / 1000
    forced_native = False
    clear_observations = 0
    # Stop the producer, then gather all descendants adopted by this subreaper.
    rows = observe()
    initial = scoped_rows(rows)
    for row in initial:
        if row['pid'] == owner.pid: signal_owned(row)
    while True:
        rows = observe()
        survivors = scoped_rows(rows)
        for row in survivors:
            identity = owned.get(key(row))
            forced_native = forced_native or bool(identity and identity['native'])
            signal_owned(row)
        owner_returncode = owner.poll()
        if owner_returncode is not None: reap()
        rows = observe()
        survivors = scoped_rows(rows)
        groups = sorted({row['pgid'] for row in owned.values() if row['native']})
        group_live = [row for row in rows.values() if live(row) and row['pgid'] in groups]
        # A live unowned group member is retained as an unresolved fact, never killed.
        if owner_returncode is not None and not survivors and not group_live:
            clear_observations += 1
            if clear_observations == 2: break
        else: clear_observations = 0
        if time.monotonic() >= end: break
        time.sleep(.01)
    result = {'status': 'verified-no-live-processes' if cleanup_verified(owner_returncode, clear_observations, survivors, group_live) else 'failed',
        'group': owner.pid, 'survivors': survivors, 'nativeGroupSurvivors': group_live,
        'nativeGroups': groups, 'ownedGroups': sorted({row['pgid'] for row in owned.values()}),
        'timeoutMs': request['cleanupTimeoutMs'], 'forcedNativeTermination': forced_native,
        'ownerReaped': owner_returncode is not None, 'ownerReturnCode': owner_returncode, 'clearObservations': clear_observations,
        'method': 'pidfd SIGKILL only to owner-bound descendants; independent live-member check of every observed native PGID',
        'scope': 'Dedicated Linux subreaper descendants, including detach/reparent before a complete browser receipt'}
    return result

owner = None
reader = writer = ack_reader = ack_writer = None
try:
    assert sys.platform == 'linux'
    assert sys.flags.isolated == 1 and sys.flags.no_site == 1
    expected_supervisor = request['nativeScope'].get('supervisor')
    if expected_supervisor:
        actual = record['infrastructure']
        assert actual['executable'] == expected_supervisor['path']
        assert actual['python'] == expected_supervisor['version']
        assert actual['executableSha256'] == expected_supervisor['sha256']
        assert actual['sourceSha256'] == expected_supervisor['sourceSha256']
        assert expected_supervisor['flags'] == ['-I', '-S']
    assert hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal')
    libc = ctypes.CDLL(None, use_errno=True)
    assert libc.prctl(36, 1, 0, 0, 0) == 0, 'Cannot become a child subreaper'
    value = ctypes.c_int()
    assert libc.prctl(37, ctypes.byref(value), 0, 0, 0) == 0 and value.value == 1
    record['subreaper'] = {'enabled': True, 'verifiedBeforeOwnerSpawn': True}
    persist()
    reader, writer = os.pipe()
    ack_reader, ack_writer = os.pipe()
    wake_reader, wake_writer = os.pipe()
    os.set_blocking(reader, False); os.set_blocking(wake_reader, False); os.set_blocking(wake_writer, False)
    signal.set_wakeup_fd(wake_writer)
    def interrupted(signum, _): record['interrupted'] = record['interrupted'] or signal.Signals(signum).name
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGCHLD, lambda *_: None)
    env = dict(os.environ)
    env['HEAP_REPAIR_NATIVE_CONTROL_FD'] = str(writer)
    env['HEAP_REPAIR_NATIVE_ACK_FD'] = str(ack_reader)
    owner = subprocess.Popen(request['command'], cwd=request['cwd'], env=env, stdin=subprocess.DEVNULL,
        stdout=None, stderr=None, start_new_session=True, pass_fds=(writer, ack_reader))
    os.close(writer); writer = None
    os.close(ack_reader); ack_reader = None
    record['ownerPid'] = owner.pid
    observe(); persist()
    select = selectors.DefaultSelector()
    select.register(reader, selectors.EVENT_READ, 'control'); select.register(wake_reader, selectors.EVENT_READ, 'signal')
    pending = b''
    while owner.poll() is None and not record['interrupted']:
        remaining = request['timeoutMs'] / 1000 - (time.monotonic() - started)
        if remaining <= 0:
            record['timedOut'] = True; break
        # No /proc polling or hashing runs during the browser's timed region.
        events = select.select(remaining)
        for event, _ in events:
            if event.data == 'signal':
                try: os.read(wake_reader, 65536)
                except BlockingIOError: pass
                continue
            chunk = os.read(reader, 1024 * 1024)
            if not chunk:
                select.unregister(reader)
                continue
            pending += chunk
            assert len(pending) < 16 * 1024 * 1024, 'Native control record too large'
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                message = json.loads(line)
                assert message['kind'] == 'native-checkpoint'
                receipt = message['receipt']
                assert receipt['ownerPid'] == owner.pid
                assert receipt['distributionManifestSha256'] == request['nativeScope']['manifestSha256']
                rows = observe()
                for claimed in receipt['observed']:
                    actual = rows.get(claimed['pid'])
                    assert actual and live(actual) and key(actual) in owned, 'Unowned native checkpoint'
                    for field in ('pid', 'ppid', 'pgid', 'session', 'startTicks'):
                        assert claimed[field] == actual[field], 'Native process identity changed: ' + field
                    retained = owned[key(actual)]
                    assert retained['native'] and claimed['executable'] == retained['executable']
                    assert claimed['executableSha256'] == retained['executableSha256']
                record['checkpoints'].append(message)
                persist()  # Persist ownership before allowing the owner to begin work.
                os.write(ack_writer, (json.dumps({'status': 'persisted', 'checkpoint': message['checkpoint']}) + '\n').encode())
    returncode = owner.poll()
    if returncode is not None:
        record['status'] = returncode if returncode >= 0 else None
        record['signal'] = signal.Signals(-returncode).name if returncode < 0 else None
except BaseException as error:
    record['error'] = '%s: %s' % (type(error).__name__, error)
finally:
    if owner is not None:
        try:
            record['cleanup'] = cleanup(owner)
            if record['cleanup']['status'] != 'verified-no-live-processes': record['error'] = record['error'] or 'Owned native cleanup incomplete'
            if record['status'] == 0 and record['cleanup']['forcedNativeTermination']:
                record['error'] = record['error'] or 'Owner exited successfully with native descendants still live; forced cleanup retained as abnormal'
        except BaseException as error:
            record['cleanup'] = {'status': 'failed', 'group': owner.pid, 'survivors': [], 'error': '%s: %s' % (type(error).__name__, error)}
            record['error'] = record['error'] or record['cleanup']['error']
    else: record['cleanup'] = {'status': 'not-started', 'group': None, 'survivors': []}
    record['finishedAtUnixSeconds'] = time.time()
    record['elapsedSeconds'] = time.monotonic() - started
    persist()
