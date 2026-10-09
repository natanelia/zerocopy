"""Strict Linux ownership/RSS adapter. Importing this module performs no I/O.

Browser spawn journals close the ancestry-poll gap, not the OS spawn-to-receipt
gap. An incomplete journal therefore never establishes verified quiescence.
All RSS maxima produced by the caller remain sampled maxima, not peaks.
"""
import errno
import hashlib
import json
import os
import pathlib
import re
import signal
import subprocess
import time


class ResourceAccountingError(RuntimeError):
    def __init__(self, message, evidence=None):
        super().__init__(message)
        self.evidence = evidence or {}


def _integer(value, minimum=1):
    return type(value) is int and value >= minimum


def identity(value):
    if not isinstance(value, dict) or not all(_integer(value.get(k)) for k in ('pid', 'group', 'session', 'startTicks')):
        raise ValueError('Missing/invalid process birth identity')
    if not _integer(value.get('ppid'), 0) or not isinstance(value.get('state'), str) or len(value['state']) != 1:
        raise ValueError('Missing/invalid process state')
    return {key: value[key] for key in ('pid', 'state', 'ppid', 'group', 'session', 'startTicks')}


def same_birth(a, b):
    return a is not None and b is not None and a['pid'] == b['pid'] and a['startTicks'] == b['startTicks']


def proc(pid):
    """Only confirmed disappearance is None. Access/parse errors are failures."""
    try:
        text = pathlib.Path(f'/proc/{int(pid)}/stat').read_text()
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH):
            return None
        raise ResourceAccountingError('Process identity unreadable', {'pid': int(pid), 'error': repr(error)}) from error
    try:
        closing = text.rindex(')')
        parts = text[closing + 2:].split()
        if int(text.split(' ', 1)[0]) != int(pid):
            raise ValueError('Stat PID mismatch')
        return identity({'pid': int(pid), 'state': parts[0], 'ppid': int(parts[1]), 'group': int(parts[2]), 'session': int(parts[3]), 'startTicks': int(parts[19])})
    except (ValueError, IndexError) as error:
        raise ResourceAccountingError('Process identity malformed', {'pid': int(pid), 'error': repr(error)}) from error


def process_table():
    try:
        entries = list(pathlib.Path('/proc').iterdir())
    except OSError as error:
        raise ResourceAccountingError('Process census unavailable', {'error': repr(error)}) from error
    result = {}
    for entry in entries:
        if entry.name.isdigit():
            value = proc(int(entry.name))
            if value is not None:
                result[value['pid']] = value
    return result


def capture_root(pid, known):
    value = proc(pid)
    if value is None or value['state'] == 'Z':
        raise ResourceAccountingError('Subject birth identity unavailable after spawn', {'pid': pid})
    if value['ppid'] != os.getpid() or value['group'] != pid or value['session'] != pid:
        raise ResourceAccountingError('Subject is not the controller child/session leader', {'identity': value})
    known[pid] = value
    return value


def _read_status(pid):
    return pathlib.Path(f'/proc/{pid}/status').read_text()


def strict_rss(owner):
    """Read bytes for this birth, allowing zero only on a confirmed exit/race."""
    owner = identity(owner)
    current = proc(owner['pid'])
    if not same_birth(owner, current) or current['state'] == 'Z':
        return 0
    failure = None
    value = None
    try:
        status = _read_status(owner['pid'])
        lines = [line for line in status.splitlines() if line.startswith('VmRSS:')]
        if len(lines) != 1 or not re.fullmatch(r'VmRSS:\s+[0-9]+\s+kB\s*', lines[0]):
            raise ValueError('VmRSS missing, duplicate, malformed, or wrong units')
        value = int(lines[0].split()[1]) * 1024
    except (OSError, ValueError) as error:
        failure = error
    # Recheck on successful reads too: a recycled PID's status is not this owner.
    after = proc(owner['pid'])
    if not same_birth(owner, after) or after['state'] == 'Z':
        return 0
    if failure is not None:
        raise ResourceAccountingError('RSS unavailable for a still-live owned identity', {'identity': owner, 'identityAfter': after, 'error': repr(failure)}) from failure
    return value


def rss_for_pid(pid):
    owner = proc(pid)
    if owner is None or owner['state'] == 'Z':
        raise ResourceAccountingError('RSS owner identity unavailable', {'pid': pid})
    return strict_rss(owner)


def _subreaper(set_enabled=False):
    # Process-local Linux setting; never invoked on import or in pure tests.
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    if set_enabled and libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER failed')
    enabled = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(enabled), 0, 0, 0) != 0:  # PR_GET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), 'PR_GET_CHILD_SUBREAPER failed')
    return enabled.value == 1


def enable_subreaper():
    try:
        if not _subreaper(set_enabled=True):
            raise ValueError('Subreaper verification failed')
    except (OSError, ValueError, AttributeError) as error:
        raise ResourceAccountingError('Kernel descendant ownership unavailable', {'error': repr(error)}) from error


def _kernel_has_children():
    """WNOWAIT observes without stealing Popen's root-child exit status."""
    try:
        os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        return True  # None means live children; a result means a waitable child.
    except ChildProcessError:
        return False  # Kernel ECHILD, not merely an empty process snapshot.


class SubreaperScope:
    def __init__(self, controller):
        self.controller = controller
        self.reaped = []
        self.kernel_empty = False

    def reconcile(self, table, known):
        if not _subreaper() or signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL or not same_birth(self.controller, table.get(self.controller['pid'])):
            raise ResourceAccountingError('Isolated subreaper identity/setting changed')
        for value in table.values():
            if value['ppid'] == self.controller['pid']:
                previous = known.get(value['pid'])
                if previous is not None and not same_birth(previous, value):
                    raise ResourceAccountingError('Owned child PID reused within the isolated scope', {'previous': previous, 'current': value})
                known[value['pid']] = value

    def reap(self, table, root):
        for value in table.values():
            if value['pid'] == root or value['ppid'] != self.controller['pid']:
                continue
            current = proc(value['pid'])
            if current is None:
                raise ResourceAccountingError('Adopted child vanished without an owned wait receipt', {'identity': value})
            if not same_birth(current, value) or current['ppid'] != self.controller['pid']:
                raise ResourceAccountingError('Adopted child identity/parent changed before wait', {'identity': value, 'current': current})
            pid, status = os.waitpid(value['pid'], os.WNOHANG)
            if pid:
                self.reaped.append({'identity': value, 'waitStatus': status})
        self.kernel_empty = not _kernel_has_children()
        return self.kernel_empty

    def receipt(self):
        return {'controller': self.controller, 'subreaperVerified': True, 'initialKernelChildrenAbsent': True,
                'adoptedChildrenReaped': self.reaped, 'finalKernelChildrenAbsent': self.kernel_empty,
                'scope': 'one isolated controller process; all orphaned descendants are adopted; final ECHILD required'}


def begin_scope():
    """Call immediately before Popen; no unrelated concurrent child work allowed."""
    try:
        if not _subreaper():
            raise ValueError('Verified subreaper is required before every owned spawn')
        if signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL:
            raise ValueError('Default SIGCHLD disposition required for owned wait receipts')
        owner = proc(os.getpid())
        if owner is None or owner['state'] == 'Z':
            raise ValueError('Controller birth identity unavailable')
        if _kernel_has_children():
            raise ValueError('Controller has pre-existing children; isolated ownership is unavailable')
        return SubreaperScope(owner)
    except (OSError, ValueError, AttributeError) as error:
        raise ResourceAccountingError('Cannot start isolated descendant ownership', {'error': repr(error)}) from error


def parse_ownership_rows(data):
    """Pure bounded journal decoder; callers decide whether all rows are present."""
    if not isinstance(data, bytes) or len(data) > 65536 or (data and not data.endswith(b'\n')):
        raise ValueError('Ownership journal is oversized or ends in a partial record')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate ownership journal field: ' + key)
            result[key] = value
        return result
    def invalid_constant(value):
        raise ValueError('Nonfinite ownership journal value: ' + value)
    return [json.loads(line, object_pairs_hook=unique, parse_constant=invalid_constant) for line in data.splitlines()]


class Ownership:
    """Consume an append-only, fsynced browser journal, including after death."""
    def __init__(self, journal_path, binding):
        self.path = pathlib.Path(journal_path)
        self.binding = dict(binding)
        self.prefix = b''
        self.problems = []
        self.engine = None
        self.adapter = None
        self.sealed = False
        self.sha256 = None

    def problem(self, text):
        if text not in self.problems:
            self.problems.append(text)

    def reconcile(self, known, final=False):
        try:
            with self.path.open('rb') as source:
                data = source.read(65537)
        except FileNotFoundError:
            if final:
                self.problem('Browser ownership journal missing; spawn ownership unknown')
            return
        except OSError as error:
            self.problem('Browser ownership journal unreadable: ' + repr(error))
            return
        if len(data) > 65536:
            self.problem('Browser ownership journal exceeds fixed 64 KiB bound')
            return
        self.sha256 = hashlib.sha256(data).hexdigest()
        if not data.startswith(self.prefix):
            self.problem('Browser ownership journal changed its retained prefix')
            return
        complete = data[:data.rfind(b'\n') + 1]
        self.prefix = complete
        if final and complete != data:
            self.problem('Browser ownership journal has a partial final record')
        self.sealed = False
        try:
            rows = parse_ownership_rows(complete)
            if len(rows) > 4:
                raise ValueError('Unexpected ownership journal record count')
            kinds = ['ownership-ready', 'engine-spawn-intent', 'engine-spawned', 'ownership-sealed']
            for index, row in enumerate(rows):
                if row.get('kind') != kinds[index] or type(row.get('sequence')) is not int or row['sequence'] != index or type(row.get('schema')) is not int or row['schema'] != 1 or row.get('binding') != self.binding:
                    raise ValueError('Ownership journal order/schema/binding mismatch')
                if index == 0:
                    adapter = identity(row.get('adapter'))
                    prior = known.get(adapter['pid'])
                    if prior is None or not same_birth(prior, adapter) or adapter['group'] != adapter['pid'] or adapter['session'] != adapter['pid']:
                        raise ValueError('Ownership journal adapter is not the captured subject birth')
                    self.adapter = adapter
                elif index == 1:
                    if type(row.get('attempt')) is not int or row['attempt'] != 1:
                        raise ValueError('Unbounded engine spawn intent')
                elif index == 2:
                    engine = identity(row.get('identity'))
                    if type(row.get('attempt')) is not int or row['attempt'] != 1 or engine['group'] != engine['pid'] or engine['session'] != engine['pid'] or engine['ppid'] != self.adapter['pid']:
                        raise ValueError('Engine was not registered as the adapter detached child/session leader')
                    previous = known.get(engine['pid'])
                    if previous is not None and not same_birth(previous, engine):
                        raise ValueError('Conflicting registered engine birth')
                    known[engine['pid']] = engine
                    self.engine = engine
                elif index == 3:
                    if type(row.get('attempts')) is not int or row['attempts'] != 1 or row.get('engineExited') is not True:
                        raise ValueError('Ownership terminal record does not prove a closed spawn adapter')
                    self.sealed = True
            if final and not self.sealed:
                self.problem('Browser spawn/receipt or adapter-exit gap remains; ownership unknown')
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            self.problem('Invalid browser ownership journal: ' + str(error))

    def receipt(self):
        return {'path': str(self.path), 'sha256': self.sha256, 'binding': self.binding, 'registeredEngine': self.engine,
                'sealed': self.sealed, 'complete': self.sealed and not self.problems, 'problems': list(self.problems),
                'durability': 'fsync before spawn intent and after birth registration; unmatched intent is unknown'}


def _owned_table(root, known, table):
    # Never turn a recycled root PID into a new ownership seed.
    parents = {pid for pid, value in known.items() if same_birth(value, table.get(pid))}
    while True:
        found = {pid for pid, value in table.items() if value['ppid'] in parents}
        if found <= parents:
            break
        parents |= found
    for pid in parents:
        if pid in known and not same_birth(known[pid], table[pid]):
            raise ResourceAccountingError('Observed descendant PID reused within the isolated scope', {'previous': known[pid], 'current': table[pid]})
        known[pid] = table[pid]
    return [value for pid, value in table.items() if pid in known and same_birth(value, known[pid]) and value['state'] != 'Z']


def census(root, known, ownership=None, scope=None, sample_rss=True):
    if ownership is not None:
        ownership.reconcile(known)
        if ownership.problems:
            raise ResourceAccountingError('Browser ownership journal is invalid', ownership.receipt())
    table = process_table()
    if scope is not None:
        scope.reconcile(table, known)
    alive = _owned_table(root, known, table)
    return alive, sum(strict_rss(value) for value in alive) if sample_rss else 0


def _signal_identity(owner, which):
    """Bind the signal to a kernel handle; a PID reuse cannot retarget it."""
    try:
        descriptor = os.pidfd_open(owner['pid'], 0)
    except ProcessLookupError:
        return
    try:
        current = proc(owner['pid'])
        if same_birth(owner, current) and current['state'] != 'Z':
            try:
                signal.pidfd_send_signal(descriptor, which)
            except ProcessLookupError:
                pass
    finally:
        os.close(descriptor)


def cleanup(child, known, grace, ownership=None, scope=None):
    """Best-effort bounded termination; an error produces unknown, never True."""
    problems = []
    deadline = time.monotonic() + grace
    term_deadline = deadline - grace * 0.25
    groups = set()
    survivors = []

    def observe(final=False):
        if ownership is not None:
            ownership.reconcile(known, final=final)
        table = process_table()
        if scope is not None:
            scope.reconcile(table, known)
        alive = _owned_table(child.pid, known, table)
        for value in known.values():
            if value['pid'] == value['group']:
                groups.add(value['group'])
        # A group number alone cannot establish ownership after PID reuse.
        for group in groups:
            leader = table.get(group)
            old = known.get(group)
            if leader is not None and old is not None and not same_birth(old, leader):
                problems.append('Owned process-group leader PID was reused: ' + str(group))
        found = [value for value in table.values() if value['state'] != 'Z' and
                 (value['group'] in groups or any(same_birth(value, owner) for owner in alive))]
        return table, alive, found

    def signals(table, alive, which):
        # Signal captured births individually. Numeric kill/killpg has a reuse
        # race; subreaper adoption lets later scans find surviving descendants.
        for value in alive:
            _signal_identity(value, which)

    try:
        if scope is None:
            problems.append('Verified isolated subreaper scope is absent; unseen detached descendants cannot be excluded')
        if child.pid not in known:
            problems.append('Subject birth identity was never captured')
        while True:
            child.poll()
            table, alive, survivors = observe()
            signals(table, alive, signal.SIGTERM)
            if not survivors or time.monotonic() >= term_deadline:
                break
            time.sleep(min(0.02, max(0, term_deadline - time.monotonic())))
        table, alive, survivors = observe()
        signals(table, alive, signal.SIGKILL)
        try:
            child.wait(timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            problems.append('Adapter did not exit within cleanup grace')
        while True:
            table, alive, survivors = observe()
            kernel_empty = scope.reap(table, child.pid) if scope is not None else False
            if (not survivors and kernel_empty) or time.monotonic() >= deadline:
                break
            signals(table, alive, signal.SIGKILL)
            time.sleep(min(0.02, max(0, deadline - time.monotonic())))
        table, _, survivors = observe(final=True)
        if scope is not None:
            scope.reap(table, child.pid)
        if scope is not None and not scope.kernel_empty:
            problems.append('Kernel still reports controller children; descendant quiescence unproven')
    except (OSError, ResourceAccountingError, ValueError, AttributeError) as error:
        problems.append('Cleanup accounting/termination failed: ' + repr(error))
    if ownership is not None:
        ownership.reconcile(known, final=True)
        problems.extend(ownership.problems)
    problems = list(dict.fromkeys(problems))
    quiescence = 'unknown' if problems else 'survivors' if survivors else 'verified'
    return {'pid': child.pid, 'group': child.pid, 'ownedGroups': sorted(groups),
            'ownedProcessIdentities': list(known.values()), 'returncode': child.poll(),
            'ownedGroupGone': quiescence == 'verified', 'quiescence': quiescence,
            'survivors': survivors, 'problems': problems,
            'descendantScope': scope.receipt() if scope is not None else None,
            'signalMethod': 'pidfd-bound owned identities; subreaper reconciliation after each termination pass',
            'ownership': ownership.receipt() if ownership is not None else None,
            'scope': 'isolated Linux subreaper descendants, captured births, durable registered engine and anchored groups; incomplete registration or non-ECHILD termination fails closed'}


def validate_cleanup_receipts(slot, config, process, cleanup_record, ownershipRows=None):
    """Pure birth-bound quiescence validation, also for failed subject/RSS runs.

    The caller binds actual paths/journal bytes and hashes. Successful subject
    status, a zero exit code and successful RSS accounting are not prerequisites
    for stably preserving failed evidence.
    """
    def require(test, message):
        if not test:
            raise ValueError(message)

    root = identity(process.get('identity'))
    require(process.get('pid') == root['pid'] and process.get('group') == root['group'] == root['pid'] == root['session'], 'Process receipt root/session mismatch')
    require(process.get('status') == 'spawned' and isinstance(process.get('command'), list) and len(process['command']) > 0 and all(isinstance(part, str) and part for part in process['command']), 'Process command/status mismatch')
    require(slot.get('runtime') in ('node', 'bun', 'chromium', 'firefox', 'webkit') and config.get('runtime') == slot['runtime'], 'Cleanup runtime/config mismatch')
    require(cleanup_record.get('pid') == root['pid'] and cleanup_record.get('group') == root['group'], 'Cleanup process mismatch')
    require(cleanup_record.get('ownedGroupGone') is True and cleanup_record.get('quiescence') == 'verified', 'Cleanup quiescence is not verified')
    require(cleanup_record.get('survivors') == [] and cleanup_record.get('problems') == [] and type(cleanup_record.get('returncode')) is int, 'Cleanup survivors/problems/unconfirmed exit')
    owners = cleanup_record.get('ownedProcessIdentities')
    require(isinstance(owners, list) and len(owners) > 0, 'Missing captured process identities')
    owners = [identity(owner) for owner in owners]
    require(len({owner['pid'] for owner in owners}) == len(owners), 'Duplicate owned process identity')
    by_pid = {owner['pid']: owner for owner in owners}
    require(same_birth(root, by_pid.get(root['pid'])), 'Cleanup lost original root birth')
    groups = cleanup_record.get('ownedGroups')
    require(isinstance(groups, list) and all(_integer(group) for group in groups) and groups == sorted(set(groups)) and root['group'] in groups, 'Invalid owned group set')
    require(all(group in by_pid and by_pid[group]['group'] == group for group in groups), 'Unbound owned process group')
    require(groups == sorted({owner['group'] for owner in owners if owner['pid'] == owner['group']}), 'Missing captured owned process group')
    scope = cleanup_record.get('descendantScope')
    require(isinstance(scope, dict), 'Missing isolated descendant ownership proof')
    controller = identity(scope.get('controller'))
    require(controller['pid'] == root['ppid'], 'Subreaper/controller parent mismatch')
    require(all(scope.get(key) is True for key in ('subreaperVerified', 'initialKernelChildrenAbsent', 'finalKernelChildrenAbsent')), 'Kernel descendant quiescence is unproven')
    reaped = scope.get('adoptedChildrenReaped')
    require(isinstance(reaped, list), 'Missing adopted-child wait receipts')
    reaped_pids = []
    for receipt in reaped:
        owner = identity(receipt.get('identity'))
        require(owner['ppid'] == controller['pid'] and same_birth(owner, by_pid.get(owner['pid'])) and _integer(receipt.get('waitStatus'), 0), 'Unbound adopted-child wait receipt')
        reaped_pids.append(owner['pid'])
    require(len(set(reaped_pids)) == len(reaped_pids), 'Duplicate adopted-child wait receipt')
    browser = slot['runtime'] in ('chromium', 'firefox', 'webkit')
    if not browser:
        require(cleanup_record.get('ownership') is None and ownershipRows is None and 'ownershipJournal' not in config and 'ownershipBinding' not in config, 'Unexpected browser ownership evidence')
        return True
    expected_binding = {'slotId': slot['id'], 'manifestSha256': config['manifestSha256'], **{key: config[key] for key in ('runtime', 'lane', 'arm', 'mode')}}
    require(config.get('ownershipBinding') == expected_binding, 'Config ownership binding mismatch')
    journal_path = config.get('ownershipJournal')
    require(isinstance(journal_path, str) and pathlib.Path(journal_path).is_absolute() and pathlib.Path(journal_path).name == slot['id'] + '.ownership.jsonl', 'Ownership journal path mismatch')
    journal = cleanup_record.get('ownership')
    require(isinstance(journal, dict) and journal.get('path') == journal_path and journal.get('binding') == expected_binding, 'Cleanup journal binding mismatch')
    require(journal.get('complete') is True and journal.get('sealed') is True and journal.get('problems') == [], 'Browser spawn ownership is unknown')
    require(isinstance(journal.get('sha256'), str) and re.fullmatch('[0-9a-f]{64}', journal['sha256']) is not None, 'Missing journal digest')
    require(isinstance(ownershipRows, list) and len(ownershipRows) == 4, 'Incomplete browser ownership journal')
    for index, kind in enumerate(('ownership-ready', 'engine-spawn-intent', 'engine-spawned', 'ownership-sealed')):
        row = ownershipRows[index]
        require(isinstance(row, dict) and row.get('kind') == kind and type(row.get('sequence')) is int and row['sequence'] == index and type(row.get('schema')) is int and row['schema'] == 1 and row.get('binding') == expected_binding, 'Journal order/schema/binding mismatch')
    adapter = identity(ownershipRows[0].get('adapter'))
    require(same_birth(adapter, root) and all(adapter[key] == root[key] for key in ('ppid', 'group', 'session')), 'Journal adapter birth differs from process receipt')
    for row in ownershipRows[1:3]:
        require(type(row.get('attempt')) is int and row['attempt'] == 1, 'Invalid browser spawn count')
    engine = identity(ownershipRows[2].get('identity'))
    require(engine['ppid'] == root['pid'] and engine['group'] == engine['pid'] == engine['session'] and engine['group'] in groups and same_birth(engine, by_pid.get(engine['pid'])), 'Engine birth/group not bound to root/cleanup')
    require(journal.get('registeredEngine') == engine, 'Registered engine differs from durable journal')
    final = ownershipRows[3]
    require(type(final.get('attempts')) is int and final['attempts'] == 1 and final.get('engineExited') is True, 'Unclosed browser spawn journal')
    return True


def validate_resource_receipts(slot, config, process, cleanup_record, record, ownershipRows=None):
    """Pure complete-subject admission. Caller separately checks file digests/caps."""
    validate_cleanup_receipts(slot, config, process, cleanup_record, ownershipRows)
    def require(test, message):
        if not test:
            raise ValueError(message)
    require(process['command'] == record.get('command'), 'Process command/status mismatch')
    require(record.get('status') == 'complete' and record.get('cleanup') == cleanup_record, 'Incomplete/mislinked resource receipt')
    require(cleanup_record['returncode'] == 0, 'Nonzero subject exit')
    accounting = record.get('resourceAccounting')
    require(isinstance(accounting, dict) and accounting.get('status') == 'complete' and accounting.get('strictRss') is True and accounting.get('sampledNotPeak') is True and _integer(accounting.get('rssSampleCount')), 'Strict sampled RSS accounting unavailable')
    require(all(_integer(record.get(key)) for key in ('maximumTreeRssBytes', 'controllerMaximumRssBytes')), 'Missing positive sampled RSS maximum')
    require(not record.get('fatalOwnedProcess') and not record.get('resourceAccountingError'), 'Failed resource accounting was admitted')
    return True
