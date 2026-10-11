"""Retained JSON comparison only. Does not import either subject."""
from pathlib import Path
import hashlib
import json
import copy

root = Path(__file__).resolve().parent
expected = json.loads((root / 'EXPECTED.json').read_text())
reports, pins = {}, []
def identity_view(value):
    """Validate retained real IDs, then alias only those IDs for cross-process comparison."""
    result = copy.deepcopy(value)
    for worker in result['workers']:
        diagnostic = worker['transportDiagnostics']
        assert set(diagnostic) == {'structureIDs', 'observedStructureIDs', 'stages'}
        stages = diagnostic['stages']; assert [row['stage'] for row in stages] == ['attach', 'pause', 'resume']
        initial = stages[0]['expected']; ids = [row['id'] for row in initial]
        assert len(ids) == len(set(ids)) == 3 and all(isinstance(id, str) for id in ids)
        aliases = {id: slot for slot, id in enumerate(ids)}
        structures = diagnostic['structureIDs']
        assert [row[0] for row in structures] == expected['workerSnapshots']
        assert all(len(row) == 2 for row in structures) and {row[1] for row in structures} == set(ids)
        assert diagnostic['observedStructureIDs'] == structures
        initial_by_id = {row['id']: row for row in initial}
        for number, stage in enumerate(stages):
            assert set(stage) == {'stage', 'expected', 'observed'}
            by_side = {}
            for side in ['expected', 'observed']:
                rows = stage[side]
                assert len(rows) == len(ids) and {row['id'] for row in rows} == set(ids)
                assert all(set(row) == {'id', 'capacity', 'used', 'prefixSHA256'} for row in rows)
                by_side[side] = {row['id']: row for row in rows}
            assert by_side['expected'] == by_side['observed'], stage
            for id, row in by_side['observed'].items():
                first = initial_by_id[id]
                assert row['used'] == first['used'] and row['prefixSHA256'] == first['prefixSHA256']
                assert row['capacity'] == first['capacity'] + (0 if worker['copy'] else number * 65536)
            for side in ['expected', 'observed']:
                stage[side] = [{**row, 'id': aliases[row['id']]} for row in stage[side]]
        diagnostic['structureIDs'] = [[name, aliases[id]] for name, id in structures]
        diagnostic['observedStructureIDs'] = [[name, aliases[id]] for name, id in diagnostic['observedStructureIDs']]
    return result

for engine in ['bun-source', 'node-portable']:
    for arm in ['baseline', 'candidate']:
        path = root / 'execution' / f'{engine}-{arm}.json'
        raw = path.read_bytes(); value = json.loads(raw)
        assert set(value) == {'schema', 'kind', 'engine', 'groups', 'workers'}
        assert value['schema'] == 1 and value['kind'] == 'lazy-traversal-correctness' and value['engine'] == engine
        assert [group['name'] for group in value['groups']] == expected['groups']
        cases = value['groups'][0]['results']
        assert [item['name'] for item in cases] == expected['shapeCases']
        by_name = {item['name']: item for item in cases}
        for name in ['empty', 'single', 'canonical-large', 'collision', 'canonical-old']:
            assert by_name[name]['shape']['overlayNodes'] == []
        assert len(by_name['canonical-large']['pointers']) == 4096
        assert by_name['collision']['shape']['collisionCount'] == 1
        assert by_name['journal']['shape']['journalDepth'] == 1 and by_name['nested-journal']['shape']['journalDepth'] == 2
        shape = by_name['late-repeated-overlay']['shape']
        assert shape['leavesBeforeFirstOverlay'] == 1 and len(set(shape['overlayNodes'])) >= 2
        assert [(item['fixture'], item['mode']) for item in value['groups'][2]['observations']] == [
            ('late', 'full'), ('late', 'close'), ('late', 'getter-error'), ('late', 'decoder-error'), ('nested-journal', 'full')]
        if engine == 'node-portable':
            assert [item['copy'] for item in value['workers']] == [False, True]
            for item in value['workers']:
                assert item['workerThread'] and item['snapshots'] == len(item['result']) == 10
                assert list(item['result']) == expected['workerSnapshots']
                assert item['frozenObjects'] and item['readOnlyRejections'] == 10 and item['allocatedSharedBytes'] == 0
                assert item['readerObservedWriterGrowth'] == (not item['copy']) and item['interleavedIteratorsPerMap'] == 2
                assert item['shape']['leavesBeforeFirstOverlay'] == 1 and len(set(item['shape']['overlayNodes'])) >= 2
            assert value['workers'][0]['result'] == value['workers'][1]['result']
        else:
            assert value['workers'] == []
        reports[engine, arm] = value
        pins.append({'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    assert identity_view(reports[engine, 'baseline']) == identity_view(reports[engine, 'candidate']), engine
assert reports['bun-source', 'baseline']['groups'] == reports['node-portable', 'baseline']['groups']

names = []
for arm in ['baseline', 'candidate']:
    path = root / 'execution' / f'tests-{arm}.json'; raw = path.read_bytes(); tests = json.loads(raw)
    assert tests['success'] and tests['numTotalTests'] == tests['numPassedTests'] == expected['testCount']
    assert tests['numFailedTests'] == tests['numPendingTests'] == tests.get('numTodoTests', 0) == 0
    actual = {Path(item['name']).name: sorted(row['title'] for row in item['assertionResults']) for item in tests['testResults']}
    assert actual == expected['titlesByFile']
    assert all(row['status'] == 'passed' for item in tests['testResults'] for row in item['assertionResults'])
    names.append(sorted(row['fullName'] for item in tests['testResults'] for row in item['assertionResults']))
    pins.append({'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
assert names[0] == names[1] and len(names[0]) == expected['testCount']
result = {'schema': 1, 'kind': 'lazy-traversal-reconciliation', 'passed': True, 'groups': expected['groups'],
          'commonGroupsPerEngineArm': 3, 'realNodeWorkerCasesPerArm': 2, 'snapshotsPerWorker': 10,
          'existingTestsPerArm': expected['testCount'], 'withinEngineReportsEqual': True, 'crossEngineSemanticGroupsEqual': True,
          'rawArenaIdentityDiagnosticsValidated': True, 'identityDiagnosticsComparedByPayloadSlot': True,
          'rawReports': pins}
with (root / 'execution/reconciliation.json').open('x') as stream:
    json.dump(result, stream, indent=2); stream.write('\n')
print(json.dumps(result))
