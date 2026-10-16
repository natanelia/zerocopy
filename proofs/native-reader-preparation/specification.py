"""Fixed prospective METHOD v4 constants. Pure Python; no subject imports."""
import hashlib
import json
import math
import statistics
from pathlib import Path

METHOD_SHA256 = '41c06e20712b3c1dcf336ea44f310a625fde85558e1d6ed61e4c5a81d420eb80'
METHOD_SEAL_SHA256 = 'b996cf69977b0465aeb6dbc404de075a6f7649bbdc1eaa8b98c66018dc7bd5f2'
BASELINE_COMMIT = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'
# Exact reviewed successor source bytes; terminal correctness is independently audited; preparation/release receipts remain absent.
CANDIDATE_COMMIT = 'b72f055e549b176ab0456704f61f298ebe5902b6'
CANDIDATE_DIFF_SHA256 = '73177be685a56e18f6bedf84577b307a9644014542bd02feffa7e24d90c10f27'
CANDIDATE_SOURCES = {'arena.ts': 'ba45cba401fd488203968d3c777f4da3a012c607f008717367f47e5915b2a274', 'compaction.ts': '1ed5601960da7226f53b65fb70b92c4e6647bcfc41f1e1efb0aaa93cca3fe343', 'shared-doubly-linked-list.ts': 'd6c50f3382d4fb833925472d32bffadce50e185f0315ec0df27ac5416d441bb8', 'shared-linked-list.ts': '394b5559269f3f5c8d8be302ce03ea38e42ffef33bf6fa927ec0f18712eaac2a', 'shared-list.ts': 'a5431504bd34f0301ee34caee8f16629de51a70dee77753d852b5ef973ff653c', 'shared-map.ts': 'f7fc165976fcf1862dec5d45549f61d875e1f8120e4111324fa2e8e4fc75f76b', 'shared-ordered-map.ts': '18e642ac5000e9d03610599f45c08648466e2d052410d23568b48e8b0bc45d0e', 'shared-queue.ts': '8ac56bde372b0123af2e77ae696ec9b6f90ea0b170e744179c4a1336ba362b02', 'shared-sorted-map.ts': '68052fb96cfbab5bdc54bce7844f83c60f6f668e00122362b0aa9b5b37a8bfc6', 'text-search.ts': '1b56b6afe5d43a8781ef231bfee5853618e05ad423de1de5ca285d9e3abf0ea5', 'worker.ts': '2d719b3496c75cb69c2e86252785b324d1e0a8228c0b83b6918727b527ea4f38'}
CANDIDATE_TESTS = {'direct-native-reader.test.ts': 'a751856e1192c24196710e66d2ea12b04007b5aa60cbe9409b19fe1edff64cb1', 'native-reader.test.ts': '434038c84aa3d0e4afed7abc62931c728a6d39108259185d053a81a00c55c8e2', 'worker.test.ts': '42834560721ff39cb4f49f99852d3ab17a65a37290fb41a9c0de621c21d98f85'}
CANDIDATE_DOCUMENTATION = {'docs/worker-sessions.md': '854695b00cb5cde30ff2e5d30ae2c56db0d37f76d713dd5fa180489a5787fa2e', 'docs/workers.md': '78bb11d42890f78d12af37ade5da58a43c5ef1027293a0a75a43b97f6438ad1b'}
CORRECTNESS_SOURCE_PINS = {'.github/workflows/direct-native-reader-correctness.yml': 'd647ee708a27253c44f60208f0a6daf5e398a16b6c461e456b1e62a49bd1053e', 'proofs/direct-native-reader-correctness/METHOD.md': '1110d8db263b17e418a2b6e989b7ea8982840de7437e9e45eab97238d2b94d11', 'proofs/direct-native-reader-correctness/artifact_checks.py': 'c4acc7ff58659f8c2db6e2e86ccfdcbadf919679c0fcf0d5e0045fd4f1cd64df', 'proofs/direct-native-reader-correctness/baseline-sources.json': '9a68795d3c96706ddcad035e7e0cf37c8635753eeb18afe128dbf32ac27f5b59', 'proofs/direct-native-reader-correctness/bounded_process.py': 'd8ed2c8a7467f8628435f92e1744d3fed1f50cabb2b30d6cd1c0983add55015e', 'proofs/direct-native-reader-correctness/dependencies/package-lock.json': '9a21d54dffb4782257ccee864de6b7f11f9c6d12a30ea8eaa411dff11cf9cfa4', 'proofs/direct-native-reader-correctness/dependencies/package.json': 'c61836da6c6d1c2699a909a1b84cc8e9f3d51ec9f27d4e0a2c5c322f7d10f02e', 'proofs/direct-native-reader-correctness/headroom.py': 'c0bf89d30b15589ed40ef0a7c5f450bc97db1233833b03a499a3412ed60e1a78', 'proofs/direct-native-reader-correctness/report_selector_test.py': 'af3661d386f13961b16e9763f7c0a9a53a42fb627b70d3cbe83840bcd5c98659', 'proofs/direct-native-reader-correctness/run.py': '9fef870f364563d2fe2fee37941e404059bc126b840f96164ee131d4e3cd5151', 'proofs/direct-native-reader-correctness/source-pins.json': '56ee0781c7a04f62c5308719f42019e18143933622e4f6b190ad697ebd0182f9', 'proofs/direct-native-reader-correctness/temp_scope_test.py': '0c93c32ad02679a45441cde927e5a71d05751cccef3bfeb0393dbde8375cd0eb', 'proofs/direct-native-reader-correctness/temp_scopes.py': 'afcecee9817832ae117ccffee9b311bde24dd6da83ff7fcfcdd9aaea95e2e98a', 'proofs/direct-native-reader-correctness/workflow_guard.py': 'eae9e6d0d269259cb5fcde9ea04824ce86c01b120d60525a6eb6e64a2eb52e2f'}
SUPERVISION_PINS = {'bounded_process.py': 'd8ed2c8a7467f8628435f92e1744d3fed1f50cabb2b30d6cd1c0983add55015e',
                    'headroom.py': 'c0bf89d30b15589ed40ef0a7c5f450bc97db1233833b03a499a3412ed60e1a78'}
RUNTIMES = {'node': {'version': 'v22.16.0', 'sha256': '8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d'},
            'bun': {'version': '1.4.2', 'sha256': 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c'}}
ROWS = ('P8', 'P1', 'N8', 'R8', 'C8', 'F8', 'W8', 'E8')
PRIMARY = ('P1', 'P8')
COMPONENT_ROWS = ('P8', 'P1', 'C8', 'F8')
COLD = ('workerImportMs', 'ownerFirstCreateMs', 'initialConnectMs', 'initialReceiverConnectMs',
        'firstP8Ms', 'firstP8AcceptanceMs', 'firstP8QueryMs')
ENGINES = ('node', 'bun')
ARMS = ('B', 'C', 'A')
ORDERS = (('B', 'C', 'A'), ('A', 'B', 'C'), ('C', 'A', 'B'),
          ('B', 'A', 'C'), ('C', 'B', 'A'), ('A', 'C', 'B'))
START_COUNTS = {row: (256 if row == 'N8' else 128 if row in ('W8','E8') else 32) for row in ROWS}
CAP_COUNTS = {row: (2**20 if row == 'N8' else 2**18 if row in ('W8','E8') else 8192) for row in ROWS}
ALLOWANCES = {'mechanism': 30, 'calibration': 90, 'rehearsal': 30, 'measurement': 30}
WHOLE_SECONDS = 1200
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
    if row == 'E8':
        require(start_variant == 0, 'E8 must query the initial variant')
        return count * oracle_total('P8', 0)
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
