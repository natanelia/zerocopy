"""Bounded Linux process-group supervisor; clocks/RSS are safety metadata only."""
import argparse, ctypes, datetime, json, os, signal, subprocess, time
from pathlib import Path


def error_info(error):
    return {'name': type(error).__name__, 'message': str(error)}


def atomic_emit(path, value):
    path = Path(path)
    temporary = Path(str(path) + '.tmp-' + str(os.getpid()))
    try:
        with temporary.open('x') as stream:
            stream.write(json.dumps(value, indent=2) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class Signals:
    """Defer catchable cancellation so Popen ownership/finalization cannot be skipped."""
    def __init__(self):
        self.first = None
        self.count = 0
        self.previous = {}

    def receive(self, number, frame):
        if self.first is None:
            self.first = number
        self.count += 1

    def __enter__(self):
        for number in (signal.SIGINT, signal.SIGTERM):
            self.previous[number] = signal.signal(number, self.receive)
        return self

    def __exit__(self, *args):
        for number, previous in self.previous.items():
            signal.signal(number, previous)


def members(group):
    found = []
    for stat in Path('/proc').glob('[0-9]*/stat'):
        try:
            pid = int(stat.parent.name)
            if os.getpgid(pid) == group:
                found.append(pid)
        except (ProcessLookupError, FileNotFoundError):
            pass
    return found


def reap():
    for _ in range(4096):
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                return
        except ChildProcessError:
            return
    raise RuntimeError('Subreaper exceeded the bounded 4096-status drain')


def cleanup_group(proc):
    result = {'attempted': True, 'scope': 'original process group only',
              'signalsAttempted': [], 'errors': [], 'remainingGroupPids': None,
              'leaderReturncode': None, 'confirmedEmpty': False}

    def record(error):
        if len(result['errors']) < 32:
            result['errors'].append(error_info(error))

    def inspect():
        try:
            result['leaderReturncode'] = proc.poll()
            # Popen collects its own child's status before the subreaper collects others.
            if result['leaderReturncode'] is not None:
                reap()
            result['remainingGroupPids'] = members(proc.pid)
        except BaseException as error:
            result['remainingGroupPids'] = None
            record(error)
        result['confirmedEmpty'] = (result['leaderReturncode'] is not None
                                    and result['remainingGroupPids'] == [])

    def send(number):
        result['signalsAttempted'].append(number)
        try:
            os.killpg(proc.pid, number)
        except ProcessLookupError:
            pass
        except BaseException as error:
            record(error)

    def drain(seconds):
        deadline = time.monotonic() + seconds
        while True:
            inspect()
            if result['confirmedEmpty'] or time.monotonic() >= deadline:
                return
            time.sleep(.05)

    try:
        inspect()
        result['remainingBeforeCleanup'] = result['remainingGroupPids']
        if not result['confirmedEmpty']:
            send(signal.SIGTERM)
            drain(2)
    except BaseException as error:
        record(error)
    finally:
        # A failed observation/grace wait still reaches the bounded KILL/reap attempt.
        if not result['confirmedEmpty']:
            send(signal.SIGKILL)
            try:
                drain(2)
            except BaseException as error:
                record(error)
                try:
                    proc.wait(timeout=2)
                except BaseException as wait_error:
                    record(wait_error)
                inspect()
    return result


def run_supervised(args):
    log = Path(args.output)
    receipt = Path(str(log) + '.json')
    log.parent.mkdir(parents=True, exist_ok=True)
    if log.exists() or receipt.exists():
        raise RuntimeError('Refusing to overwrite original evidence')
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        raise RuntimeError('Missing command')
    result = {'command': command, 'cwd': args.cwd, 'state': 'failed',
              'returncode': None, 'supervisorLimit': None, 'peakPolledRSS': 0,
              'primaryError': None, 'interruptionSignal': None,
              'cleanup': None, 'spawned': False,
              'scope': 'Safety receipt only; original process group; no SIGKILL/host-death or escaped-group cleanup guarantee'}
    proc = None
    with Signals() as signals:
        try:
            result['startedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
                raise RuntimeError('Cannot establish child-subreaper cleanup')
            start = time.monotonic()
            with log.open('xb') as out:
                if signals.first is None:
                    proc = subprocess.Popen(command, cwd=args.cwd, stdout=out,
                                            stderr=subprocess.STDOUT, start_new_session=True)
                    result['spawned'] = True
                    result['pid'] = proc.pid
                    while signals.first is None and proc.poll() is None:
                        rss = 0
                        for pid in members(proc.pid):
                            try:
                                for line in Path('/proc', str(pid), 'status').read_text().splitlines():
                                    if line.startswith('VmRSS:'):
                                        rss += int(line.split()[1]) * 1024
                            except (ProcessLookupError, FileNotFoundError):
                                pass
                        result['peakPolledRSS'] = max(result['peakPolledRSS'], rss)
                        if rss > args.rss_mib * 1048576:
                            result['supervisorLimit'] = 'rss'
                            break
                        if time.monotonic() - start > args.seconds:
                            result['supervisorLimit'] = 'deadline'
                            break
                        time.sleep(.1)
                    result['returncode'] = proc.poll()
        except BaseException as error:
            result['primaryError'] = error_info(error)
        finally:
            if proc is not None:
                result['cleanup'] = cleanup_group(proc)
                result['returncode'] = result['cleanup']['leaderReturncode']
            result['interruptionSignal'] = signals.first
            result['interruptionCount'] = signals.count
            interrupted = signals.first is not None or (result['primaryError'] or {}).get('name') == 'KeyboardInterrupt'
            clean = result['cleanup']
            passed = (result['spawned'] and result['returncode'] == 0
                      and result['primaryError'] is None and result['supervisorLimit'] is None
                      and clean['confirmedEmpty'] and not clean['errors']
                      and clean.get('remainingBeforeCleanup') == [])
            result['state'] = 'interrupted' if interrupted else 'passed' if passed else 'failed'
            result['endedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            # Receipt failure cannot undo cleanup; caller gets a nonzero failure, never a pass.
            atomic_emit(receipt, result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seconds', type=int, required=True)
    parser.add_argument('--rss-mib', type=int, default=1024)
    parser.add_argument('--cwd', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    result = run_supervised(parser.parse_args())
    print(json.dumps(result), flush=True)
    return 0 if result['state'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
