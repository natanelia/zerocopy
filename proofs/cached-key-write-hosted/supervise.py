"""Fresh bounded runner. Clocks/RSS are safety metadata, never benchmark data."""
import argparse
import ctypes
import datetime
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def members(group):
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            if os.getpgid(pid) == group:
                found.append(pid)
        except ProcessLookupError:
            pass
    return sorted(found)


def rss_bytes(pids):
    total = 0
    for pid in pids:
        try:
            for line in Path(f'/proc/{pid}/status').read_text().splitlines():
                if line.startswith('VmRSS:'):
                    total += int(line.split()[1]) * 1024
                    break
        except FileNotFoundError:
            pass
    return total


def reap():
    for _ in range(4096):
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                return
        except ChildProcessError:
            return
    raise RuntimeError('Reap count exceeded 4096')


def cleanup(proc):
    result = {'remainingBeforeCleanup': None, 'remainingAfterCleanup': None,
              'confirmedEmpty': False, 'signals': [], 'errors': []}

    def inspect():
        code = proc.poll()
        if code is not None:
            reap()
        result['remainingAfterCleanup'] = members(proc.pid)
        result['confirmedEmpty'] = code is not None and not result['remainingAfterCleanup']

    def send(number):
        result['signals'].append(number)
        try:
            os.killpg(proc.pid, number)
        except ProcessLookupError:
            pass

    def drain(seconds):
        deadline = time.monotonic() + seconds
        while True:
            inspect()
            if result['confirmedEmpty'] or time.monotonic() >= deadline:
                return
            time.sleep(.05)

    try:
        inspect()
        result['remainingBeforeCleanup'] = result['remainingAfterCleanup']
        if not result['confirmedEmpty']:
            send(signal.SIGTERM)
            drain(2)
    except BaseException as error:
        result['errors'].append(repr(error))
    finally:
        if not result['confirmedEmpty']:
            try:
                send(signal.SIGKILL)
                drain(2)
            except BaseException as error:
                result['errors'].append(repr(error))
                try:
                    proc.wait(timeout=2)
                    inspect()
                except BaseException as final_error:
                    result['errors'].append(repr(final_error))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cwd', required=True)
    parser.add_argument('--seconds', type=float, required=True)
    parser.add_argument('--rss-mib', type=int, required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or not 0 < args.seconds <= 1800 or not 0 < args.rss_mib <= 4096:
        raise ValueError('Command and finite positive caps required')
    cwd = Path(args.cwd).resolve(strict=True)
    output = Path(args.output).resolve()
    receipt = Path(str(output) + '.receipt.json')
    if output.exists() or receipt.exists():
        raise FileExistsError('Original evidence may not be overwritten')
    output.parent.mkdir(parents=True, exist_ok=True)
    record = {'schema': 1, 'command': command, 'cwd': str(cwd),
              'secondsCap': args.seconds, 'rssMiBCap': args.rss_mib,
              'state': 'failed', 'spawned': False, 'returncode': None,
              'limit': None, 'error': None, 'signal': None, 'peakPolledRSS': 0,
              'cleanup': None, 'scope': 'Original process group only; no escaped-group or host-death cleanup guarantee'}
    started = time.monotonic()
    record['startedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    previous = {}
    proc = None

    def interrupted(number, _frame):
        if record['signal'] is None:
            record['signal'] = number

    for number in (signal.SIGINT, signal.SIGTERM):
        previous[number] = signal.signal(number, interrupted)
    try:
        # Reap orphaned descendants in the original group after their leader exits.
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'Cannot enable child subreaper')
        with output.open('xb') as log:
            if record['signal'] is not None:
                raise InterruptedError('Interrupted before child creation')
            proc = subprocess.Popen(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT,
                                    start_new_session=True, stdin=subprocess.DEVNULL)
            record['spawned'] = True
            record['pid'] = proc.pid
            while True:
                code = proc.poll()
                if code is not None:
                    record['returncode'] = code
                    break
                rss = rss_bytes(members(proc.pid))
                record['peakPolledRSS'] = max(record['peakPolledRSS'], rss)
                if record['signal'] is not None:
                    break
                if rss > args.rss_mib * 1048576:
                    record['limit'] = 'rss'
                    break
                if time.monotonic() - started >= args.seconds:
                    record['limit'] = 'seconds'
                    break
                time.sleep(.05)
    except BaseException as error:
        record['error'] = repr(error)
    finally:
        if proc is not None:
            record['cleanup'] = cleanup(proc)
            record['returncode'] = proc.poll()
        record['endedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        record['elapsedSeconds'] = time.monotonic() - started
        clean = record['cleanup']
        if (record['spawned'] and record['returncode'] == 0 and not record['error']
                and record['signal'] is None and record['limit'] is None and clean
                and clean['confirmedEmpty'] and not clean['remainingBeforeCleanup']
                and not clean['errors']):
            record['state'] = 'passed'
        with receipt.open('x') as stream:
            json.dump(record, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        for number, handler in previous.items():
            signal.signal(number, handler)
    print(json.dumps(record))
    return 0 if record['state'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
