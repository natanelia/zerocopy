"""Audit a cancelled attempt without treating it as a completed study.

Run from the repository root:
  python proofs/map-batch-delete-direct-20261108/validation/attempt1/audit-partial.py

Reads the lossless retained attempt archives. Does not time, build, or execute
the project. Reuses the independently written Python fixture primitives.
"""
from pathlib import Path
import collections
import gzip
import hashlib
import json
import math
import statistics
import sys

here = Path(__file__).resolve().parent
repository = here.parents[3]
reviewer = here.parent / 'independent-review.py'
output = here / 'independent-review.partial.json'
sys.argv = [str(reviewer), str(here / 'results'), str(repository), str(output)]
namespace = {'__file__': str(reviewer), '__name__': 'partial_audit_primitives'}
prefix = reviewer.read_text().split("\nformal, formal_sha = load('formal')", 1)[0]
assert prefix != reviewer.read_text()
exec(compile(prefix, str(reviewer), 'exec'), namespace)
load, fixture, close = [namespace[name] for name in ('load', 'fixture', 'close')]
formal, formal_sha = load('formal')
pilot, pilot_sha = load('pilot-v3')
pilot_review = namespace['paired'](pilot, 64)
assert formal['status'] == 'running' and 'failure' not in formal
assert 'completedAt' not in formal
assert formal['mode'] == 'formal'
assert formal['schema'] == pilot['schema']
assert formal['source'] == pilot['source']
assert formal['snapshots'] == pilot['snapshots']
assert formal['driver'] == pilot['driver']
assert formal['workload'] == pilot['workload']
assert formal['study'] == pilot['study']
method, runs = formal['method'], formal['runs']
cases = method['cases']
assert [s['name'] for s in cases] == namespace['ALL_CASES']
assert method['pairs'] == 6 and method['minimumWarmupMs'] == 500
assert method['minimumWarmupBatches'] == 8 and method['samples'] == 9
assert len(runs) == 331
schedule = []
for pair in range(6):
    for runtime in (['node', 'bun'] if pair % 2 == 0 else ['bun', 'node']):
        for spec in (cases if pair % 2 == 0 else cases[::-1]):
            for variant in (['before', 'after'] if pair % 2 == 0 else ['after', 'before']):
                schedule.append((pair, runtime, spec['name'], variant))
assert [(r['pair'], r['runtime'], r['caseName'], r['variant']) for r in runs] == schedule[:len(runs)]
estimates, versions, fixture_hashes = {}, {}, {}
last = namespace['timestamp'](formal['startedAt'])
for run in runs:
    spec = next(s for s in cases if s['name'] == run['caseName'])
    assert run['spec'] == spec
    assert not run['stderr'] and run['affinity'] == formal['host']['affinity']
    assert run['executable'] == method['runtimes'][run['runtime']]
    independent = fixture(spec)
    assert run['expectedDigest'] == independent['expectedDigest'], run['caseName']
    details = run['fixture']
    for key in ('kind', 'count', 'requested', 'pattern'):
        assert details[key] == spec[key]
    assert details['unicode'] == spec.get('unicode', False)
    assert details['resultCount'] == independent['resultCount']
    assert details['sourceConstruction'] == independent['sourceConstruction']
    fixture_hashes.setdefault(spec['name'], details)
    assert fixture_hashes[spec['name']] == details
    versions.setdefault(run['runtime'], run['versions'])
    assert versions[run['runtime']] == run['versions']
    key = (run['pair'], run['runtime'], run['caseName'], run['variant'])
    estimates[key] = namespace['distributions'](run, 500, spec['repetitions'])
    start, end = [namespace['timestamp'](run[k]) for k in ('startedAt', 'completedAt')]
    assert start >= last and end >= start
    assert sum(run['warmupBatchMs'] + run['sampleBatchMs']) <= (end - start) * 1000 + 1
    last = end
    timing = run['batchTiming']
    close(timing['minimumObservedMs'], min(run['warmupBatchMs'] + run['sampleBatchMs']))
    close(timing['minimumMeasuredMs'], min(run['sampleBatchMs']))
    assert timing['measuredBelow2ms'] == sum(ms < 2 for ms in run['sampleBatchMs'])
    assert timing['warmupBelow2ms'] == sum(ms < 2 for ms in run['warmupBatchMs'])
rows = []
assert len(formal['summary']) == len(cases) * 2
for row in formal['summary']:
    paired = []
    for pair in range(6):
        key = (pair, row['runtime'], row['name'])
        if (*key, 'before') in estimates and (*key, 'after') in estimates:
            b, a = estimates[*key, 'before'], estimates[*key, 'after']
            paired.append({'pair': pair, 'before': b, 'after': a, 'ratio': a / b})
    assert len(paired) == len(row['points'])
    for expected, actual in zip(paired, row['points']):
        assert expected['pair'] == actual['pair']
        for field in ('before', 'after', 'ratio'): close(actual[field], expected[field])
    ratio = math.exp(statistics.mean(math.log(p['ratio']) for p in paired))
    close(row['pairedRatio'], ratio)
    close(row['beforeMs'], statistics.median(p['before'] for p in paired))
    close(row['afterMs'], statistics.median(p['after'] for p in paired))
    assert row['interval95'] is None
    assert row['fasterPairs'] == sum(p['ratio'] < 1 for p in paired)
    rows.append({'runtime': row['runtime'], 'name': row['name'], 'role': row['role'],
                 'completedPairs': len(paired), 'beforeUs': row['beforeMs'] * 1000,
                 'afterUs': row['afterMs'] * 1000, 'pairedRatio': ratio,
                 'changePercent': (ratio - 1) * 100, 'fasterPairs': row['fasterPairs'],
                 'interpretation': 'provisional descriptive estimate; incomplete prespecified study; no confidence or acceptance claim'})
short = []
for runtime in ('node', 'bun'):
    for spec in cases:
        for variant in ('before', 'after'):
            values = [ms for r in runs if (r['runtime'], r['caseName'], r['variant']) ==
                      (runtime, spec['name'], variant) for ms in r['sampleBatchMs']]
            count = sum(ms < 2 for ms in values)
            if count: short.append({'runtime': runtime, 'name': spec['name'], 'variant': variant,
                                    'below2ms': count, 'minimumMs': min(values)})
counts = collections.Counter((r['runtime'], r['pair'] + 1) for r in runs)
report = {
    'schema': 'zerocopy-map-delete-partial-attempt-audit/v1',
    'passedAvailableRecordChecks': True, 'completeStudy': False, 'retimed': False,
    'missingStages': ['formal: 101 of 432 planned processes', 'aa: all 32 processes', 'reference-comparison: all 54 processes'],
    'recordSha256': {'formal.json': formal_sha, 'pilot-v3.json': pilot_sha},
    'independentScriptSha256': hashlib.sha256(reviewer.read_bytes()).hexdigest(),
    'partialAuditSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'currentSourcesWasmAndBundlesExactlyMatchHostedCandidate': True,
    'allSourceSnapshotsDriverAndWorkloadHashesVerified': True,
    'completePilot': pilot_review,
    'partialFormal': {
        'processes': len(runs), 'expectedProcesses': len(schedule), 'measuredBatches': len(runs) * 9,
        'verifiedOutputs': sum(r['verifiedOutputs'] for r in runs),
        'warmupBatches': sum(len(r['warmupBatchMs']) for r in runs),
        'minimumMeasuredBatchMs': min(ms for r in runs for ms in r['sampleBatchMs']),
        'measuredBatchesBelow2ms': sum(ms < 2 for r in runs for ms in r['sampleBatchMs']),
        'shortBatchesByCase': short,
        'processesByRuntimeAndRound': {f'{runtime}:{pair}': count for (runtime, pair), count in counts.items()},
        'lastCompletedProcess': {key: runs[-1][key] for key in ('runtime', 'caseName', 'variant', 'pair', 'startedAt', 'completedAt')},
        'interruptedNextProcess': dict(zip(('pair', 'runtime', 'caseName', 'variant'), schedule[len(runs)])),
        'rows': rows,
    },
    'independentlyReconstructedFixtures': [{'name': spec['name'], **fixture(spec)} for spec in cases],
    'decision': 'No final acceptance: cancelled at the 60-minute limit before the prespecified formal study, A/A controls and reference comparison finished. All available timings and unfavorable estimates remain retained. No completed measurement is discarded or represented as a complete study.',
}
with output.open('x') as handle:
    json.dump(report, handle, indent=2, ensure_ascii=False); handle.write('\n')
print(json.dumps({'availableChecksPassed': True, 'formalProcesses': len(runs), 'pilotProcesses': 64,
                  'measuredBatchesBelow2ms': report['partialFormal']['measuredBatchesBelow2ms'],
                  'rows': rows}, indent=2))
