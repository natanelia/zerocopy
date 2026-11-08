#!/usr/bin/env python3
"""Recompute the rejected getMany study without executing its JS verifier or timing.

Requires Python 3 and scipy. Usage:
  python3 independent-review.py RECORDS_DIR CANDIDATE_REPO BASELINE_REPO OUTPUT_JSON

RECORDS_DIR accepts the original downloaded JSON or its lossless .json.gz copies.
The candidate and baseline arguments must contain the exact recorded builds.
"""
import datetime as dt
import gzip
import hashlib
import json
import math
import pathlib
import re
import statistics as stats
import subprocess
import sys
from scipy.stats import t

records_dir, repository, baseline_dir, output = map(pathlib.Path, sys.argv[1:])
proof = repository / 'proofs/map-bulk-reads-20261108'
BASELINE = 'a4265a0608ec25eec5719496225212db6b251989'
CANDIDATE = '0f6f19844349a48cd2ad20e570953b9279778871'
NAMES = ['formal', 'aa', 'pilot-v2-hosted', 'pilot-v1', 'aa-diagnostic-v1']
COUNTS = dict(zip(NAMES, [216, 64, 72, 56, 32]))
CORE = ['persistent-core.wasm', 'shared-map.wasm', 'shared-list.wasm',
        'linked-list.wasm', 'singly-linked-list.wasm', 'doubly-linked-list.wasm',
        'ordered-map.wasm', 'sorted-tree.wasm', 'priority-queue.wasm']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_hash(value):
    return sha(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode())


def close(actual, expected):
    assert math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-12), (actual, expected)


def read_record(directory, name):
    path = directory / (name + '.json')
    if not path.exists():
        path = directory / (name + '.json.gz')
    raw = path.read_bytes()
    if path.suffix == '.gz':
        raw = gzip.decompress(raw)
    return json.loads(raw), raw


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def specifications(legacy):
    rows = [
        ('number-hit-128', 'number', 'target', 128, 'hit', 4096),
        ('number-hit-1024', 'number', 'target', 1024, 'hit', 256),
        ('number-mixed-1024', 'number', 'control', 1024, 'mixed', 128),
        ('number-miss-128', 'number', 'control', 128, 'miss', 512),
        ('string-hit-128', 'string', 'target', 128, 'hit', 4096),
        ('object-hit-128', 'object', 'control', 128, 'hit', 1024),
        ('scalar-number-control', 'number', 'control', 128, 'scalar', 4096),
        ('cold-number-1024', 'number', 'control', 1024, 'cold', 64),
        ('changing-root-1024', 'number', 'control', 1024, 'root-change', 256),
    ]
    result = [dict(zip(['name', 'type', 'role', 'count', 'mode', 'repetitions'], row)) for row in rows]
    if legacy:
        result = result[:7]
        for spec, repetitions in zip(result, [2048, 256, 128, 256, 1024, 256, 2048]):
            spec['repetitions'] = repetitions
    return result


def fixture(spec, legacy):
    """Build an independent native semantic oracle, including exact JSON key order."""
    def value(i):
        if spec['type'] == 'number':
            return i + .25
        if spec['type'] == 'string':
            return f'label/é/界/🙂/{i}'
        assert spec['type'] == 'object'
        return {'id': i, 'coordinates': [i, i + .25]}

    entries = {f'id{i}': value(i) for i in range(4096)}
    keys = [f'absent{i}' if spec['mode'] == 'miss' or spec['mode'] == 'mixed' and i % 2
            else f'id{(i * 73 + 19) % 4096}' for i in range(spec['count'])]
    expected = [entries.get(key, ['undefined']) for key in keys]
    digest_input = {'spec': spec, 'keys': keys, 'values': expected}
    if not legacy:
        alternate = [-999.25] + expected[1:] if spec['mode'] == 'root-change' else None
        digest_input['alternateValues'] = alternate
    return json_hash(digest_input), sum(key in entries for key in keys)


def serial_windows(record):
    last = timestamp(record['startedAt'])
    for run in record['runs']:
        start, end = timestamp(run['startedAt']), timestamp(run['completedAt'])
        assert start >= last and end >= start
        assert sum(run['warmupBatchMs'] + run['sampleBatchMs']) <= (end - start) * 1000 + 1
        last = end
    assert timestamp(record['completedAt']) >= last


def inventory(root, field):
    if field == 'sources':
        names = [p.name for p in root.iterdir() if p.is_file() and
                 (p.name.endswith('.ts') and not p.name.endswith('.test.ts') or
                  re.fullmatch(r'tsconfig.*\.json', p.name))]
        return sorted(names + ['package.json', 'scripts/build-browser.ts', 'scripts/build-wasm.mjs'])
    return sorted(p.name for p in (root / 'dist' if field == 'bundles' else root).iterdir()
                  if p.is_file() and p.suffix == ('.js' if field == 'bundles' else '.wasm'))


def current_identity(identity, root):
    for field in ('sources', 'wasm', 'bundles'):
        assert inventory(root, field) == sorted(identity[field]), (root, field, 'inventory')
        directory = root / 'dist' if field == 'bundles' else root
        for name, digest in identity[field].items():
            assert sha((directory / name).read_bytes()) == digest, (root, field, name)


records, raw_hashes = {}, {}
for name in NAMES:
    record, raw = read_record(records_dir, name)
    records[name], raw_hashes[name] = record, sha(raw)
    # Check the compressed archive preserved every byte, including original whitespace.
    _, archived = read_record(proof / 'results', name)
    assert archived == raw, (name, 'archive changed original bytes')

formal = records['formal']
for side, root in [('before', baseline_dir), ('after', repository)]:
    current_identity(formal['source'][side], root)
for name, digest in formal['source']['before']['sources'].items():
    content = subprocess.check_output(['git', '-C', str(baseline_dir), 'show', f'{BASELINE}:{name}'])
    assert sha(content) == digest, ('baseline commit', name)


def audit_record(name, record):
    legacy = name in ('pilot-v1', 'aa-diagnostic-v1')
    mode, method, runs = record['mode'], record['method'], record['runs']
    assert record['schema'] == 'zerocopy-paired-public-operation/v1'
    assert record['status'] == 'complete' and 'failure' not in record
    expected_mode = 'formal' if name == 'formal' else 'aa' if 'aa' in name else 'pilot'
    assert mode == expected_mode
    specs = specifications(legacy)
    assert record['study']['cases'] == specs
    aa_names = (['number-hit-128', 'scalar-number-control'] if name == 'aa-diagnostic-v1' else
                ['number-hit-128', 'number-mixed-1024', 'cold-number-1024', 'scalar-number-control'])
    cases = [s for s in specs if s['name'] in aa_names] if mode == 'aa' else specs
    assert method['cases'] == cases
    pairs = {'formal': 6, 'aa': 4, 'pilot': 2}[mode]
    assert method['pairs'] == pairs and len(runs) == COUNTS[name] == len(cases) * pairs * 4
    warmup_ms = 150 if name == 'pilot-v1' else 500
    assert method['minimumWarmupMs'] == warmup_ms
    assert method['minimumWarmupBatches'] == 8 and method['samples'] == 9
    assert record['host']['affinity'].isdigit()
    assert record['study']['baseline'] == record['source']['before']['commit'] == BASELINE
    assert record['source']['after']['commit'] == (BASELINE if legacy or mode == 'aa' else CANDIDATE)
    changed = ['shared-map.ts'] if legacy else ['arena.ts', 'shared-map.ts']
    assert record['study']['changedSources'] == changed and record['study']['changedWasm'] == []
    assert set(record['snapshots']) == set(changed)
    for filename, variants in record['snapshots'].items():
        for variant, content in variants.items():
            assert sha(content.encode()) == record['source'][variant]['sources'][filename]
    for side in ('before', 'after'):
        for filename in CORE:
            assert record['source'][side]['wasm'][filename] == record['source'][side]['wasm']['persistent-core.wasm']
    assert record['source']['before']['wasm'] == record['source']['after']['wasm']
    for field in ('sources', 'wasm', 'bundles'):
        assert record['source']['before'][field] == formal['source']['before'][field]
        if mode == 'aa':
            assert record['source']['before'][field] == record['source']['after'][field]
        elif not legacy:
            assert record['source']['after'][field] == formal['source']['after'][field]
    source_changes = sorted(k for k in record['source']['before']['sources']
                            if record['source']['before']['sources'][k] != record['source']['after']['sources'][k])
    assert source_changes == ([] if mode == 'aa' else sorted(changed))
    source_root = proof / 'exploration/v1' if legacy else proof
    assert sha((source_root / 'paired-benchmark.mjs').read_bytes()) == record['driver']['sha256']
    workload_name = 'aa-diagnostic-workloads.mjs' if name == 'aa-diagnostic-v1' else 'workloads.mjs'
    assert sha((source_root / workload_name).read_bytes()) == record['workload']['sha256']
    if name == 'pilot-v1':
        assert (source_root / 'shared-map.ts').read_text() == record['snapshots']['shared-map.ts']['after']
        assert sha((source_root / 'arena.ts').read_bytes()) == record['source']['after']['sources']['arena.ts']

    schedule = [(pair, runtime, spec['name'], variant)
                for pair in range(pairs)
                for runtime in (['node', 'bun'] if pair % 2 == 0 else ['bun', 'node'])
                for spec in (cases if pair % 2 == 0 else cases[::-1])
                for variant in (['before', 'after'] if pair % 2 == 0 else ['after', 'before'])]
    assert schedule == [(r['pair'], r['runtime'], r['caseName'], r['variant']) for r in runs]
    assert len(set(schedule)) == len(runs)
    spec_by_name = {s['name']: s for s in cases}
    fixtures = {s['name']: fixture(s, legacy) for s in cases}
    estimates, versions, first_fixture, trends = {}, {}, {}, []
    for run in runs:
        spec = spec_by_name[run['caseName']]
        assert run['spec'] == spec and run['affinity'] == record['host']['affinity']
        assert not run['stderr'] and run['executable'] == method['runtimes'][run['runtime']]
        versions.setdefault(run['runtime'], run['versions'])
        assert run['versions'] == versions[run['runtime']]
        digest, hits = fixtures[spec['name']]
        assert run['expectedDigest'] == digest, (name, spec['name'], 'semantic oracle')
        details = run['fixture']
        assert details['sourceCount'] == 4096 and details['requestCount'] == spec['count']
        assert details['type'] == spec['type'] and details['mode'] == spec['mode'] and details['hitCount'] == hits
        assert isinstance(details['sourceBytes'], int) and details['sourceBytes'] > 0
        assert re.fullmatch('[a-f0-9]{64}', details['sourceBytesHash'])
        first_fixture.setdefault(spec['name'], details)
        assert details == first_fixture[spec['name']], (name, spec['name'], 'cross-process fixture identity')
        warm, samples = run['warmupBatchMs'], run['sampleBatchMs']
        assert len(warm) >= 8 and sum(warm) >= warmup_ms and len(samples) == 9
        assert all(math.isfinite(ms) and ms > 0 for ms in warm + samples)
        assert len(warm) == 8 or sum(warm[:-1]) < warmup_ms
        estimate = stats.median(samples) / spec['repetitions']
        close(run['medianMs'], estimate)
        assert run['verifiedOutputs'] == (len(warm) + len(samples)) * spec['repetitions']
        timing = run['batchTiming']
        close(timing['minimumObservedMs'], min(warm + samples))
        close(timing['minimumMeasuredMs'], min(samples))
        assert timing['measuredBelow2ms'] == sum(ms < 2 for ms in samples)
        assert timing['warmupBelow2ms'] == sum(ms < 2 for ms in warm)
        key = (run['pair'], run['runtime'], run['caseName'], run['variant'])
        estimates[key] = estimate
        tail_to_samples = stats.median(samples) / stats.median(warm[-9:])
        sample_change = stats.median(samples[-3:]) / stats.median(samples[:3])
        if abs(tail_to_samples - 1) > .20 or abs(sample_change - 1) > .20:
            trends.append({'pair': run['pair'], 'runtime': run['runtime'], 'name': run['caseName'],
                           'variant': run['variant'], 'sampleMedianOverLastNineWarmupMedian': tail_to_samples,
                           'lastThreeSamplesOverFirstThreeSamples': sample_change})
    rows = []
    expected_row_keys = [(runtime, spec['name']) for runtime in ('node', 'bun') for spec in cases]
    assert [(r['runtime'], r['name']) for r in record['summary']] == expected_row_keys
    for row in record['summary']:
        before, after, ratios = [], [], []
        assert row['role'] == spec_by_name[row['name']]['role'] and len(row['points']) == pairs
        for pair in range(pairs):
            b = estimates[pair, row['runtime'], row['name'], 'before']
            a = estimates[pair, row['runtime'], row['name'], 'after']
            point = row['points'][pair]
            assert point['pair'] == pair
            close(point['before'], b); close(point['after'], a); close(point['ratio'], a / b)
            before.append(b); after.append(a); ratios.append(a / b)
        logs = [math.log(r) for r in ratios]
        center = stats.mean(logs)
        ratio = math.exp(center)
        interval = None
        close(row['pairedRatio'], ratio)
        close(row['beforeMs'], stats.median(before)); close(row['afterMs'], stats.median(after))
        assert row['fasterPairs'] == sum(r < 1 for r in ratios)
        if pairs > 2:
            width = t.ppf(.975, pairs - 1) * stats.stdev(logs) / math.sqrt(pairs)
            interval = [math.exp(center - width), math.exp(center + width)]
            for actual, expected in zip(row['interval95'], interval):
                close(actual, expected)
        else:
            assert row['interval95'] is None
        classification = ('pilot-only' if interval is None else 'faster' if interval[1] < 1 else
                          'slower' if interval[0] > 1 else 'inconclusive')
        rows.append({'runtime': row['runtime'], 'name': row['name'], 'role': row['role'],
                     'beforeMs': stats.median(before), 'afterMs': stats.median(after), 'pairedRatio': ratio,
                     'interval95': interval, 'fasterPairs': sum(r < 1 for r in ratios), 'pairs': pairs,
                     'changePercent': (ratio - 1) * 100, 'classification': classification})
    serial_windows(record)
    samples = [ms for r in runs for ms in r['sampleBatchMs']]
    warm = [ms for r in runs for ms in r['warmupBatchMs']]
    return {'rawSha256': raw_hashes[name], 'processes': len(runs), 'measuredBatches': len(samples),
            'warmupBatches': len(warm), 'verifiedOutputs': sum(r['verifiedOutputs'] for r in runs),
            'minimumMeasuredBatchMs': min(samples), 'measuredBatchesBelow2ms': sum(ms < 2 for ms in samples),
            'warmupBatchesBelow2ms': sum(ms < 2 for ms in warm), 'versions': versions,
            'fixtureDigests': {k: {'expectedDigest': v[0], 'hitCount': v[1],
                                  'sourceBytes': first_fixture[k]['sourceBytes'],
                                  'sourceBytesHash': first_fixture[k]['sourceBytesHash']} for k, v in fixtures.items()},
            'rows': rows, 'processesWithOver20PercentLateMovement': len(trends),
            'lateMovement': trends}


audits = {name: audit_record(name, record) for name, record in records.items()}
for name in ('formal', 'aa', 'pilot-v2-hosted'):
    assert audits[name]['versions'] == audits['formal']['versions']
assert all(row['classification'] == 'inconclusive' for row in audits['aa']['rows'])

ci = {}
for name in ('browser', 'worker-current', 'worker-baseline'):
    path = proof / 'validation/hosted' / (name + '.json')
    result = json.loads(path.read_text())
    assert result['passed'] is True and result['independentInputOracles'] is True
    assert result['operations'] == ['getMany', 'get', 'has']
    rows = result['results']
    assert {(r['copy'], r['valueType']) for r in rows} == {
        (copy, kind) for copy in (False, True) for kind in ('number', 'boolean', 'string', 'object')}
    assert len(rows) == 8
    for row in rows:
        for key in ('retainedBytesUnchanged', 'readerAllocationsUnchanged', 'oldMissAndNewPresenceVerified'):
            assert row[key] is True
        assert row['reads'] > 0 and row['sourceCount'] == 2055 and row['resultCount'] == 2056
        assert row['checkedSnapshots'] == ['before', 'after', 'fork', 'compacted']
        assert row.get('finalCapacity', row.get('newCapacity')) > row.get('initialCapacity', row.get('oldCapacity'))
    if name == 'browser':
        assert result['crossOriginIsolated'] is True
    ci[name] = {'passed': True, 'cases': 8, 'recordSha256': sha(path.read_bytes())}

report = {
    'passed': True, 'decision': 'reject-getMany-v2-no-pr',
    'method': 'Independent Python reconstruction of semantic fixtures and all five recorded studies; SciPy Student-t quantiles; no JS verifier execution and no timing rerun.',
    'baselineCommit': BASELINE, 'candidateCommit': CANDIDATE,
    'sourceBuildIdentity': {
        'currentCandidateAndBaselineMatchAllRecordedFiles': True,
        'eachSide': {k: len(formal['source']['before'][k]) for k in ('sources', 'wasm', 'bundles')},
        'baselineRuntimeSourcesMatchPinnedGitCommit': True,
        'wasmUnchangedAndAllNineCoreAliasesMatch': True,
        'allArchivedRawRecordsPreservedByteExactly': True,
        'historicalV1ChangedSourceAndDriverWorkloadSnapshotsMatch': True,
    },
    'hostedProvenance': {'runId': 42504561217, 'jobId': 128804276166, 'artifactId': 13626752507,
                         'artifactZipSha256': 'c96fc3c1959ad9cd79a2cf7abcab6b6393115f09d725e9f6c94fe585b1971c9a'},
    'records': audits, 'hostedCorrectness': ci,
    'limitations': [
        'Read-state setup, full retained-output verification, and source-byte hashes are outside each measured operation batch; their allocation and CPU effects may extend into later batches.',
        'Cold cases create fresh reader caches outside timing; underlying memory and already-created query strings are shared and warm.',
        'Root-change measures two retained roots on one reader arena, not an arbitrary stream of new roots.',
        'Hosted A/A covers four representative rows; its broad intervals do not prove zero regression, and no A/A subtraction was used.',
        'Student-t intervals are unadjusted across workloads. Two-pair pilots remain descriptive with no confidence intervals.',
        'Historical V1 used eager verification messages and repeated deep object checks. Its candidate bundle hashes are preserved in the raw manifest; those historical candidate bundle bytes are not rebuilt by this audit.',
        'Semantic fixture digests were reconstructed independently. Binary fixture images were not retained, so their recorded hashes are checked for exact consistency across every build/runtime/pair rather than recomputed from an image.',
        'Late movement reports describe raw changes only; they do not establish JIT, GC, scheduler, or other causal attribution.',
    ],
    'conclusion': 'Node numeric hits and the two-root case improve, while six Bun rows regress in all six pairs with intervals wholly above 1. The large repeatable automatic-path regressions outweigh the scoped Node gains. The candidate is rejected; no PR or further timing is warranted.',
}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + '\n')
print(json.dumps({'passed': True, 'decision': report['decision'], 'records': {
    name: {k: audit[k] for k in ('processes', 'measuredBatches', 'measuredBatchesBelow2ms',
                               'processesWithOver20PercentLateMovement')} for name, audit in audits.items()},
    'output': str(output)}, indent=2))
