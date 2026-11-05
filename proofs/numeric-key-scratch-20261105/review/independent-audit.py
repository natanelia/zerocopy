#!/usr/bin/env python3
"""Audit the completed numeric-key pilot from saved JSON/gzip only.

No library, JS driver, compiler or benchmark is imported or run. --proof can
optionally verify the five frozen proof-file hashes; live production/build
hashes were checked separately before restoration. Native expected digests,
caps, process statistics, counters and recorded storage consistency are
independently reconstructed here. The saved JSON contains hashes/counters,
not the actual collection outputs, so output materialization is not rerun.
"""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import statistics

CONFIG = {
    'pilot': {'pairs': 2, 'samples': 7, 'warmupMs': 150},
    'formal': {'pairs': 6, 'samples': 11, 'warmupMs': 500},
    'targetBatchMs': 20, 'minWarmupBatches': 8, 'maxWarmupBatches': 1024,
    'maxCalibrationSteps': 12, 'maxAllocatedBytes': 16777216,
    'maxRepeat': 65536, 'maxWrites': 131072, 'childTimeoutMs': 180000,
}
CASES = [
    ('map-unicode-short', 'SharedMap', 'number', 1024, 'short', False),
    ('map-unicode-medium', 'SharedMap', 'number', 256, 'medium', False),
    ('map-unicode-one', 'SharedMap', 'number', 1, 'short', False),
    ('map-unicode-replace', 'SharedMap', 'number', 1024, 'short', True),
    ('ordered-unicode-short', 'SharedOrderedMap', 'number', 1024, 'short', False),
    ('sorted-unicode-short', 'SharedSortedMap', 'number', 1024, 'short', False),
    ('map-ascii-control', 'SharedMap', 'number', 1024, 'ascii', False),
    ('map-long-fitting-control', 'SharedMap', 'number', 16, 'long-fitting', False),
    ('map-oversized-control', 'SharedMap', 'number', 8, 'oversized', False),
    ('map-json-control', 'SharedMap', 'object', 256, 'short', False),
]
MATRIX = []
for name, collection, kind, count, keys, replace in CASES:
    spec = dict(name=name, collection=collection, type=kind, count=count, keys=keys)
    if replace:
        spec['replace'] = True
    MATRIX.append(spec)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def close(actual, expected):
    assert math.isfinite(actual) and math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-11), (actual, expected)


def js_numbers(value):
    # These finite fixtures use no exponential JSON numbers. JS serializes
    # integral binary64 values and signed zero without a decimal suffix.
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [js_numbers(v) for v in value]
    if isinstance(value, dict):
        return {k: js_numbers(v) for k, v in value.items()}
    return value


def encoded(value):
    return json.dumps(js_numbers(value), ensure_ascii=False, separators=(',', ':')).encode()


def native(spec):
    count = spec['count']
    keys = []
    for i in range(count):
        suffix = str(i * 4051 % 4099).zfill(4)
        mode = spec['keys']
        key = f'road/{suffix}/position' if mode == 'ascii' else f'界{suffix}/' + '路é' * 128 + '/🙂' if mode == 'medium' else f'é{suffix}/' + 'é' * 16382 if mode == 'long-fitting' else f'界{suffix}/' + '界' * 16385 if mode == 'oversized' else f'路/{suffix}/café🙂'
        keys.append(key)
    assert len(set(keys)) == count
    values = [{'id': i, 'label': f'value/{i}/界🙂', 'active': i % 2 == 0, 'nested': [i * .25, -i, None]} if spec['type'] == 'object' else i + .25 for i in range(count)]
    model = [[k, v] for k, v in zip(keys, values)]
    base = [[k, -i - .5] for i, k in enumerate(keys)] if spec.get('replace') else []
    middle = [[k, v] for k, v in base]
    if base:
        for i in range((count >> 1) + 1):
            middle[i][1] = values[i]
    else:
        middle = model[:(count >> 1) + 1]
    key_bytes = [len(k.encode()) for k in keys]
    key_units = [len(k.encode('utf-16-le')) // 2 for k in keys]
    estimated = sum(n + 512 + (8 if spec['type'] == 'number' else len(encoded(values[i]))) for i, n in enumerate(key_bytes))
    return {'expectedDigest': sha(encoded({'model': model, 'base': base, 'middle': middle, 'sortedKeys': sorted(keys, key=lambda k: k.encode())})),
            'outputElements': len(model) + len(middle), 'baseElements': len(base), 'writesPerOperation': count,
            'keyUnits': {'min': min(key_units), 'max': max(key_units)}, 'keyBytes': {'min': min(key_bytes), 'max': max(key_bytes)},
            'estimatedAllocationBytes': estimated, 'maxRepeat': min(65536, 131072 // count, max(1, 16777216 // estimated))}


def subject(s, spec, plan, stage):
    expected = native(spec)
    assert s['status'] == 'complete' and s['phase'] == stage and s['runtime'] == plan['runtime'] and s['name'] == spec['name']
    assert s['initialVerified'] is True and s['publishedBytesVerified'] is True
    assert s['versions']['bun' if s['runtime'] == 'bun' else 'node'] == ('1.4.2' if s['runtime'] == 'bun' else '24.22.1')
    for key, value in expected.items():
        assert s[key] == value, (spec['name'], key, s[key], value)
    assert s['expectedDigest'] == plan['expectedDigest'] and s['initialStorage'] == plan['initialStorage']
    assert s['capped'] == (s['repeat'] == s['maxRepeat'])
    assert s['storage'] == s['storageByRepeat'][str(s['repeat'])]
    assert 8 <= len(s['warmup']) <= 1024
    close(s['warmupMs'], math.fsum(b['ms'] for b in s['warmup']))
    assert s['warmupMs'] >= 150
    assert len(s['warmup']) == 8 or math.fsum(b['ms'] for b in s['warmup'][:-1]) < 150
    assert s['warmupCalls'] == sum(b['repeat'] for b in s['warmup'])
    initial_repeat = min(s['maxRepeat'], math.ceil(8192 / spec['count'])) if stage == 'calibrate' else plan['repeat']
    assert all(b['repeat'] == initial_repeat for b in s['warmup'])
    batches = list(s['warmup'])
    if stage == 'calibrate':
        assert s['samples'] == [] and 1 <= len(s['calibration']) <= 12
        repeat = initial_repeat
        for i, step in enumerate(s['calibration']):
            assert step['repeat'] == repeat and len(step['trials']) == 3
            assert all(b['repeat'] == repeat for b in step['trials'])
            batches.extend(step['trials'])
            elapsed = statistics.median(b['ms'] for b in step['trials'])
            stop = elapsed >= 25 or repeat == s['maxRepeat']
            if i < len(s['calibration']) - 1:
                assert not stop
                repeat = min(s['maxRepeat'], math.ceil(repeat * max(1.1, min(8, 30 / max(elapsed, .001)))))
            else:
                assert stop
        assert s['repeat'] == repeat
        close(s['minMsPerCall'], min(b['ms'] / repeat for b in s['calibration'][-1]['trials']))
    else:
        assert s['calibration'] == [] and len(s['samples']) == 7 and s['repeat'] == plan['repeat']
        assert all(b['repeat'] == plan['repeat'] for b in s['samples'])
        assert s['storage'] == plan['storage']
        batches.extend(s['samples'])
        close(s['medianMs'], statistics.median(b['ms'] / s['repeat'] for b in s['samples']))
        close(s['minBatchMs'], min(b['ms'] for b in s['samples']))
        assert s['belowTargetBatches'] == sum(b['ms'] < 20 for b in s['samples'])
    assert set(s['storageByRepeat']) == {str(b['repeat']) for b in batches}
    for storage in [s['initialStorage'], *s['storageByRepeat'].values()]:
        assert storage['verifiedBaseElements'] == expected['baseElements']
        assert storage['usedBefore'] >= 65536 and storage['usedAfter'] >= storage['usedBefore']
        assert storage['allocatedBytes'] == storage['usedAfter'] - storage['usedBefore']
        assert 0 <= storage['allocatedBytes'] <= 16777216
        assert storage['capacityBefore'] >= storage['usedBefore'] and storage['capacityAfter'] >= storage['usedAfter']
        assert storage['capacityBefore'] % 65536 == storage['capacityAfter'] % 65536 == 0
        for key in ('prefixSha256', 'payloadSha256', 'descriptorSha256'):
            assert re.fullmatch(r'[0-9a-f]{64}', storage[key])
        if not expected['baseElements']:
            assert storage['usedBefore'] == 65536 and storage['prefixSha256'] == sha(b'')
        for key in ('usedBefore', 'capacityBefore', 'prefixSha256'):
            assert storage[key] == s['initialStorage'][key]
    for b in batches:
        repeat = b['repeat']; storage = s['storageByRepeat'][str(repeat)]
        assert isinstance(repeat, int) and 1 <= repeat <= s['maxRepeat'] and math.isfinite(b['ms']) and b['ms'] > 0
        assert b['verifiedCalls'] == repeat and b['verifiedElements'] == repeat * expected['outputElements']
        assert b['verifiedWrites'] == repeat * spec['count'] and b['verifiedBaseElements'] == expected['baseElements']
        for key in ('payloadSha256', 'descriptorSha256', 'allocatedBytes', 'capacityAfter'):
            assert b[key] == storage[key]
    for stored, row in [('checkedCalls', 'verifiedCalls'), ('checkedElements', 'verifiedElements'), ('checkedWrites', 'verifiedWrites'), ('checkedBaseElements', 'verifiedBaseElements')]:
        assert s[stored] == sum(b[row] for b in batches)
    return len(batches)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('record', type=Path)
    parser.add_argument('--proof', type=Path, help='Optional proof folder for the five frozen input hashes')
    args = parser.parse_args()
    packed = args.record.read_bytes(); raw = gzip.decompress(packed) if args.record.suffix == '.gz' else packed; r = json.loads(raw)
    assert r['schema'] == 1 and r['status'] == 'complete' and r['phase'] == 'pilot' and r['pilotFile'] is None
    assert r['config'] == CONFIG and r['cases'] == MATRIX
    assert r['hardware']['affinity'] == '2' and r['hardware']['availableParallelism'] == 1
    source = r['source']; before, after = source['baseline'], source['candidate']
    assert before['commit'] == '77599337867dbf785a5f0311d34637d0b36678fc' and after['commit'] == 'ee80a1c2353a867f0efda4356d17b949ee16d0be'
    assert before['production'].keys() == after['production'].keys()
    assert [p for p in before['production'] if before['production'][p] != after['production'][p]] == ['arena.ts']
    assert before['support'] == after['support'] and before['wasm'] == after['wasm']
    for tree in (before, after):
        for group in ('production', 'tests', 'support', 'wasm', 'bundles', 'ci'):
            assert all(h is None or re.fullmatch(r'[0-9a-f]{64}', h) for h in tree[group].values())
        assert 'dist/shared.js' in tree['bundles'] and any('chunk-' in p for p in tree['bundles'])
    assert set(source['driver']) == {'benchmark.mjs', 'fixtures.mjs', 'worker.mjs', 'compatibility.mjs', 'PLAN.md'}
    if args.proof:
        for name, expected in source['driver'].items():
            assert sha((args.proof / name).read_bytes()) == expected, name
    keys = [(runtime, spec['name']) for runtime in ('node', 'bun') for spec in MATRIX]
    assert [(p['runtime'], p['name']) for p in r['plans']] == keys
    assert [(p['runtime'], p['name']) for p in r['summary']] == keys
    plans = {(p['runtime'], p['name']): p for p in r['plans']}; specs = {s['name']: s for s in MATRIX}
    calibration, measured, batches = [], [], 0
    shared_storage = {}
    for runtime, name in keys:
        plan = plans[runtime, name]; index = next(i for i, s in enumerate(MATRIX) if s['name'] == name)
        assert plan['order'] == (['candidate', 'baseline'] if index % 2 else ['baseline', 'candidate'])
        for build in plan['order']:
            s = plan['calibration'][build]; batches += subject(s, specs[name], plan, 'calibrate'); calibration.append(s)
            for repeat, storage in s['storageByRepeat'].items():
                slot = (runtime, name, repeat)
                if slot in shared_storage: assert shared_storage[slot] == storage
                else: shared_storage[slot] = storage
        assert plan['repeat'] == max(s['repeat'] for s in plan['calibration'].values())
        assert plan['storage'] == shared_storage[runtime, name, str(plan['repeat'])]
    order = [(runtime, spec['name'], pair) for runtime in ('node', 'bun') for pair in range(2) for spec in (MATRIX[pair:] + MATRIX[:pair])]
    assert [(p['runtime'], p['name'], p['pair']) for p in r['pairs']] == order
    for pair in r['pairs']:
        assert pair['mode'] == 'ab' and pair['order'] == (['after', 'before'] if pair['pair'] else ['before', 'after'])
        plan = plans[pair['runtime'], pair['name']]
        for side in pair['order']:
            s = pair[side]; batches += subject(s, specs[pair['name']], plan, 'measure'); measured.append(s)
            assert s['storage'] == shared_storage[pair['runtime'], pair['name'], str(plan['repeat'])]
    sequence = [s for runtime in ('node', 'bun') for group in (calibration, measured) for s in group if s['runtime'] == runtime]
    assert [s['sequence'] for s in sequence] == list(range(120))
    print(f'PASS saved pilot: {len(raw)} raw bytes; SHA-256 {sha(raw)}')
    print('Native input digests, key unit/byte lengths, caps, initial/full-heap/descriptor storage equality, counts, warm-up and balanced process sequence verified.')
    print('runtime | workload | before ms/operation | after ms/operation | paired after/before | pair ratios')
    for row in r['summary']:
        pairs = [p for p in r['pairs'] if (p['runtime'], p['name']) == (row['runtime'], row['name'])]
        assert len(pairs) == row['pairs'] == 2 and row['mode'] == 'ab'
        a = [p['after']['medianMs'] for p in pairs]; b = [p['before']['medianMs'] for p in pairs]
        ratios = [x/y for x,y in zip(a,b)]; ratio = math.exp(statistics.fmean(math.log(v) for v in ratios))
        close(row['beforeMedianMs'], statistics.median(b)); close(row['afterMedianMs'], statistics.median(a)); close(row['ratio'], ratio)
        close(row['minRatio'], min(ratios)); close(row['maxRatio'], max(ratios))
        assert len(row['pairRatios']) == 2 and 'lower95' not in row and 'upper95' not in row
        for stored, value in zip(row['pairRatios'], ratios): close(stored, value)
        print(f"{row['runtime']} | {row['name']} | {statistics.median(b):.9f} | {statistics.median(a):.9f} | {ratio:.9f} | " + ', '.join(f'{v:.9f}' for v in ratios))
    print(f'Verified {len(measured)} measured-process medians, {len(r["pairs"])} ratios, {len(r["summary"])} rows, {sum(len(s["samples"]) for s in measured)} measured batches; plus {len(calibration)} calibrations and {batches} total timed warm/calibration/measured batches.')
    print(f'Measured-subject recorded checks: calls={sum(s["checkedCalls"] for s in measured)}, writes={sum(s["checkedWrites"] for s in measured)}, output elements={sum(s["checkedElements"] for s in measured)}, retained base elements={sum(s["checkedBaseElements"] for s in measured)}. Untimed initial checks are separate.')
    for runtime in ('node', 'bun'):
        group = [s for s in measured if s['runtime'] == runtime]; times = [b['ms'] for s in group for b in s['samples']]
        print(f'{runtime}: actual timed warm-up {min(s["warmupMs"] for s in group):.6f}–{max(s["warmupMs"] for s in group):.6f} ms; shortest batch {min(times):.6f} ms; below-target batches {sum(t<20 for t in times)}/{len(times)}.')
    print('No library import, build, unit test, performance measurement or source change was performed.')


if __name__ == '__main__':
    main()
