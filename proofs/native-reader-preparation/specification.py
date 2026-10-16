"""Fixed prospective METHOD v2 constants. Pure Python; no subject imports."""
import hashlib
import json
import math
import statistics
from pathlib import Path

METHOD_SHA256 = '24fc7ac4ea6b84d5d08c340d4468bb36693e31c14b3b9e08a24359af3140a880'
METHOD_SEAL_SHA256 = 'b04d20e6a88c7bbcde9a3f963b3323d7273689b64851d446c9e1c243af69a251'
BASELINE_COMMIT = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'
CANDIDATE_DIFF_SHA256 = '75680715f2313604e4cb8ba5f41c0c2655f272a511899cb05d352b05032cfcb6'
CANDIDATE_SOURCES = {'arena.ts': '8603c3b219e1435ea882799ca0abe9d8492209e001e535e17f18f56a6920ec7b',
                     'worker.ts': '2d719b3496c75cb69c2e86252785b324d1e0a8228c0b83b6918727b527ea4f38'}
SUPERVISION_PINS = {'bounded_process.py': 'd8ed2c8a7467f8628435f92e1744d3fed1f50cabb2b30d6cd1c0983add55015e',
                    'headroom.py': 'c0bf89d30b15589ed40ef0a7c5f450bc97db1233833b03a499a3412ed60e1a78'}
RUNTIMES = {'node': {'version': 'v22.16.0', 'sha256': '8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d'},
            'bun': {'version': '1.4.2', 'sha256': 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c'}}
ROWS = ('P8', 'P1', 'N8', 'R8', 'C8', 'F8', 'W8')
PRIMARY = ('P1', 'P8')
COMPONENT_ROWS = ('P8', 'P1', 'C8', 'F8')
COLD = ('workerImportMs', 'ownerFirstCreateMs', 'initialConnectMs', 'initialReceiverConnectMs',
        'firstP8Ms', 'firstP8AcceptanceMs', 'firstP8QueryMs')
ENGINES = ('node', 'bun')
ARMS = ('B', 'C', 'A')
ORDERS = (('B', 'C', 'A'), ('A', 'B', 'C'), ('C', 'A', 'B'),
          ('B', 'A', 'C'), ('C', 'B', 'A'), ('A', 'C', 'B'))
START_COUNTS = {row: (256 if row == 'N8' else 128 if row == 'W8' else 32) for row in ROWS}
CAP_COUNTS = {row: (2**20 if row == 'N8' else 2**18 if row == 'W8' else 8192) for row in ROWS}
ALLOWANCES = {'mechanism': 30, 'calibration': 90, 'rehearsal': 30, 'measurement': 30}
WHOLE_SECONDS = 900
FINAL_RESERVE_SECONDS = 30
MIN_AVAILABLE_BYTES = 2 * 2**30
RSS_LIMIT_BYTES = 2**30
T_CRITICAL = 2.200985160
CASE = json.loads(Path(__file__).with_name('cases.json').read_text())


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def count_valid(row, count):
    return type(count) is int and 1 <= count <= CAP_COUNTS[row]


def next_count(row, count, elapsed):
    require(count_valid(row, count) and positive(elapsed), 'invalid calibration input')
    # JS Math.round, rather than Python's ties-to-even round.
    return min(CAP_COUNTS[row], max(1, math.floor(count * 50 / elapsed + .5)))


def schedule():
    groups = []
    def add(mode, engine, arm, block=None):
        index = len(groups)
        groups.append({'mode': mode, 'engine': engine, 'arm': arm, 'block': block, 'processOrder': index,
                       'label': f'{index:02d}-{mode}-{engine}-{arm.lower()}' + (f'-{block:02d}' if block else ''),
                       'wallSeconds': ALLOWANCES[mode]})
    for engine in ENGINES:
        for arm in ('B', 'C'):
            add('mechanism', engine, arm)
    for mode in ('calibration', 'rehearsal'):
        for engine in ENGINES:
            add(mode, engine, 'B')
    for block in range(1, 13):
        for engine in (ENGINES if block % 2 else ENGINES[::-1]):
            for arm in ORDERS[(block-1) % 6]:
                add('measurement', engine, arm, block)
    return groups


SEQUENCE = schedule()
CASE_SHA256 = digest(CASE)
SEQUENCE_SHA256 = digest(SEQUENCE)


def oracle_total(row, variant):
    require(variant in (0, 1) and type(variant) is int, 'invalid fixture variant')
    # Independent formula, never the manifest's declared totals or observed output.
    indexes = [(17*q) % 128 for q in range(16)]
    if row == 'P1':
        return sum(100000 if variant and i == 0 else i for i in indexes)
    total_quarters = 0
    for j in range(8):
        for i in indexes:
            price_quarters = 400 + 40*j + i
            if row == 'F8':
                price_quarters += 4000*variant
            elif row in ('P8', 'C8', 'W8') and variant and j == i == 0:
                price_quarters += 4
            total_quarters += price_quarters
    return total_quarters // 4


def checksum(row, count, start_variant, initial_version=None):
    require(count_valid(row, count), 'invalid batch count')
    if row == 'N8':
        require(type(initial_version) is int and initial_version >= 0, 'missing unchanged version')
        return count * initial_version
    if row in ('R8', 'W8'):
        return count * oracle_total(row, start_variant)
    return ((count+1)//2) * oracle_total(row, start_variant) + (count//2) * oracle_total(row, 1-start_variant)


def calibration_row(row, batches, declared):
    require(type(declared) is dict and type(batches) is list, 'missing calibration evidence')
    trials = declared.get('trials')
    require(type(trials) is int and 1 <= trials <= 3 and len(batches) == trials*5, 'calibration trial count')
    attempted = START_COUNTS[row]
    qualified = False
    medians = []
    for trial in range(trials):
        group = batches[trial*5:(trial+1)*5]
        require([b.get('stage') for b in group] == ['warmup']*2+['pilot']*3, 'calibration batch order')
        require(all(b.get('trial') == trial and b.get('count') == attempted for b in group), 'untried or mismatched calibration count')
        require(all(positive(b.get('elapsedMs')) for b in group), 'nonfinite or nonpositive calibration duration')
        median = statistics.median(b['elapsedMs'] for b in group[2:])
        medians.append(median)
        qualified = 40 <= median <= 80
        require(not qualified or trial == trials-1, 'calibration continued after qualification')
        if trial < trials-1:
            attempted = next_count(row, attempted, median)
    require(qualified or trials == 3, 'unqualified calibration stopped early')
    require(declared.get('count') == attempted and declared.get('qualified') is qualified, 'calibration declaration mismatch')
    return {'count': attempted, 'qualified': qualified, 'trials': trials, 'pilotMedianMs': medians}
