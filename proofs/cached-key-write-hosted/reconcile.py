"""Retained correctness JSON only. Does not import or execute either subject."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent
expected = json.loads((root / 'EXPECTED.json').read_bytes())
reports, pins = {}, []
sha = lambda data: hashlib.sha256(data).hexdigest()

def check_groups(groups):
    assert [g['name'] for g in groups] == expected['groups']
    basic, limits, aliases, reentry, oversized, nested = groups
    assert basic['hitIdentityPreserved'] and basic['undefinedPointerInitialized']
    assert len(basic['rows']) == 3 and basic['cache']['keyCount'] == 4 and basic['pointerCache']['keyCount'] == 2
    assert limits['countBefore'] == 2047 and limits['countAfter'] == limits['countCache']['keyCount'] == 2048
    assert limits['reentrantByteCounts'] == [196607, 262143, 262144]
    assert limits['byteCache']['keyBytes'] == 262144 and limits['byteCache']['keyCount'] == 6
    assert all(limits[k] for k in ['rejectedCountMiss', 'rejectedByteMiss', 'neverCacheableMiss', 'emptyAtByteCapAdmitted'])
    assert aliases['discardedCalls'] == 0 and aliases['exactAliasTokensDistinct']
    assert aliases['old']['size'] == 1 and aliases['next']['size'] == aliases['repeat']['size'] == 5
    assert reentry['events'] == ['hot', 'cold', 'unicode', 'proxy', 'getter']
    assert reentry['initialCapacity'] == 131072 and reentry['finalCapacity'] > reentry['initialCapacity']
    assert all(reentry[k] for k in ['thrownIdentityPreserved', 'asciiFirstInsertionWon', 'unicodePointerSetByReentry', 'sideResultRetained'])
    assert [r['kind'] for r in oversized['results']] == ['map', 'ordered', 'sorted']
    for row in oversized['results']:
        assert [r['encodedKeyPlusValue'] for r in row['sizes']] == [49152, 49153]
        assert row['calls'] == 2 and row['tokenIdentityPreserved']
    assert nested['tokenIdentityPreserved'] and [r['size'] for r in nested['rows']] == [1, 2]

def check_workers(workers):
    assert [w['copy'] for w in workers] == [False, True]
    for worker in workers:
        assert worker['workerThread'] and worker['snapshots'] == expected['snapshotsPerWorker'] == 6
        assert list(worker['result']) == expected['workerSnapshots']
        assert worker['allocatedSharedBytes'] == worker['serializationCalls'] == 0
        assert worker['readOnlyRejections'] == 6 and worker['frozenObjects']
        assert worker['readerObservedWriterGrowth'] == (not worker['copy'])
        d = worker['transportDiagnostics']
        assert set(d) == {'structureIDs', 'observedStructureIDs', 'stages'}
        assert d['structureIDs'] == d['observedStructureIDs']
        assert [name for name, _id in d['structureIDs']] == expected['workerSnapshots']
        assert [s['stage'] for s in d['stages']] == ['attach', 'resume']
        initial = {r['id']: r for r in d['stages'][0]['expected']}
        assert set(initial) == set(expected['workerArenaIDs']) and len(initial) == 4
        assert set(_id for _, _id in d['structureIDs']) == set(initial) - {'cached-key/nested-child'}
        for stage in d['stages']:
            by_side = {}
            for side in ['expected', 'observed']:
                rows = stage[side]
                assert len(rows) == len(initial) and {r['id'] for r in rows} == set(initial)
                assert all(set(r) == {'id', 'capacity', 'used', 'prefixSHA256'} for r in rows)
                by_side[side] = {r['id']: r for r in rows}
            assert by_side['expected'] == by_side['observed']
            for _id, row in by_side['observed'].items():
                before = initial[_id]
                assert row['used'] == before['used'] and row['prefixSHA256'] == before['prefixSHA256']
                if worker['copy'] or stage['stage'] == 'attach' or _id != 'cached-key/basic':
                    assert row['capacity'] == before['capacity']
                else:
                    assert row['capacity'] > before['capacity']
    assert workers[0]['result'] == workers[1]['result']

for engine in ['bun-source', 'node-portable']:
    for arm in ['baseline', 'candidate']:
        path = root / 'execution' / f'{engine}-{arm}.json'; raw = path.read_bytes(); value = json.loads(raw)
        assert set(value) == {'schema', 'kind', 'engine', 'groups', 'workers'}
        assert value['schema'] == 1 and value['kind'] == 'cached-key-write-correctness' and value['engine'] == engine
        check_groups(value['groups'])
        if engine == 'node-portable':
            check_workers(value['workers'])
        else:
            assert value['workers'] == []
        reports[engine, arm] = value
        pins.append({'path': str(path), 'bytes': len(raw), 'sha256': sha(raw)})
    # Constructor-supplied fixed fixture IDs make full raw reports comparable;
    # no key, allocation, pointer, capacity, payload digest, or observer is masked.
    assert reports[engine, 'baseline'] == reports[engine, 'candidate'], engine
assert reports['bun-source', 'baseline']['groups'] == reports['node-portable', 'baseline']['groups']

names = []
for arm in ['baseline', 'candidate']:
    path = root / 'execution' / f'tests-{arm}.json'; raw = path.read_bytes(); tests = json.loads(raw)
    assert tests['success'] and tests['numTotalTests'] == tests['numPassedTests'] == expected['testCount']
    assert tests['numFailedTests'] == tests['numPendingTests'] == tests.get('numTodoTests', 0) == 0
    actual = {}
    for item in tests['testResults']:
        name = Path(item['name']).name
        assert name not in actual and item['status'] == 'passed'
        assert all(row['status'] == 'passed' for row in item['assertionResults'])
        actual[name] = sorted(row['title'] for row in item['assertionResults'])
    assert actual == expected['titlesByFile']; names.append(actual)
    pins.append({'path': str(path), 'bytes': len(raw), 'sha256': sha(raw)})
assert names[0] == names[1]
result = {'passed': True, 'kind': 'cached-key-write-reconciliation', 'groups': expected['groups'],
          'withinEngineReportsEqual': True, 'crossEngineSemanticGroupsEqual': True,
          'realNodeWorkerCasesPerArm': 2, 'snapshotsPerWorker': 6, 'existingTestsPerArm': expected['testCount'],
          'fixedArenaIDsVerified': True, 'mergedPR30BulkAssertionsBothArms': True, 'reports': pins}
with (root / 'execution/reconciliation.json').open('x') as stream:
    json.dump(result, stream, indent=2); stream.write('\n')
print(json.dumps(result))
