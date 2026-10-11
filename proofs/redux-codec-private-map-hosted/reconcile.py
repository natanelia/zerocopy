"""Compare retained correctness reports only; never imports either subject."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent
expected = json.loads((root / 'EXPECTED.json').read_text())
reports, pins = {}, []
for engine in ['bun-source', 'node-portable']:
    for arm in ['baseline', 'candidate']:
        path = root / 'execution' / f'{engine}-{arm}.json'
        raw = path.read_bytes(); value = json.loads(raw)
        assert set(value) == {'schema', 'kind', 'engine', 'groups', 'sourceWrapper'}
        assert value['schema'] == 1 and value['kind'] == 'redux-classifier-correctness' and value['engine'] == engine
        assert [group['name'] for group in value['groups']] == expected['groups']
        classes, observers, public, codec = value['groups']
        assert [(row['label'], row['kind'], row['size']) for row in classes['accepted']] == [
            (label, kind, 0 if label == 'empty' else 3) for label in ['empty', 'nonempty'] for kind in expected['kinds']]
        assert [(row['copy'], row['kind'], row['size'], row['readOnly']) for row in classes['attachments']] == [
            (copy, kind, 3, True) for copy in [False, True] for kind in expected['kinds']]
        assert classes['attachmentMode'] == 'same-process-real-initWorker-no-worker-thread'
        assert len(classes['rejected']) == 19
        assert len(observers['observerRows']) == 19 and len(observers['proxyRows']) == 6
        assert observers['revokedObject'] == 'TypeError' and observers['revokedCallable'] is False
        assert public['kindsChecked'] == expected['kinds'] and public['middlewareErrors'] == []
        for field in ['oldSnapshotPreserved', 'descriptorsPreserved', 'unchangedArenaAllocation',
                      'earlySharedMapSelectorSameIdentity', 'unrelatedRootSameIdentity', 'missing']:
            assert public[field] is True
        assert codec['restoredKinds'] == [[kind, 3, True] for kind in expected['kinds']]
        assert codec['checkpointWritable'] and codec['nestedFrozen'] and codec['packageClassIdentity']
        assert codec['toolkitOldSize'] == 0 and codec['toolkitNewValue'] == 42
        assert value['sourceWrapper'] == (expected['sourceWrapper'] if engine == 'bun-source' else None)
        reports[engine, arm] = value
        pins.append({'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    assert reports[engine, 'baseline'] == reports[engine, 'candidate'], engine
assert reports['bun-source', 'baseline']['groups'] == reports['node-portable', 'baseline']['groups']

names = []
for arm in ['baseline', 'candidate']:
    path = root / 'execution' / f'tests-{arm}.json'; raw = path.read_bytes(); tests = json.loads(raw)
    assert tests['success'] and tests['numTotalTests'] == tests['numPassedTests'] == expected['testCount']
    assert tests['numFailedTests'] == tests['numPendingTests'] == tests.get('numTodoTests', 0) == 0
    actual = {Path(item['name']).name: sorted(row['title'] for row in item['assertionResults']) for item in tests['testResults']}
    assert len(tests['testResults']) == 4 and actual == expected['titlesByFile']
    assert all(row['status'] == 'passed' for item in tests['testResults'] for row in item['assertionResults'])
    names.append(sorted(row['fullName'] for item in tests['testResults'] for row in item['assertionResults']))
    pins.append({'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
assert names[0] == names[1] and len(names[0]) == expected['testCount']
result = {'schema': 1, 'kind': 'redux-classifier-reconciliation', 'passed': True,
          'groups': expected['groups'], 'attachmentCasesPerArmEngine': 24,
          'existingTestsPerArm': expected['testCount'], 'withinEngineReportsEqual': True,
          'crossEngineSemanticGroupsEqual': True, 'rawReports': pins}
with (root / 'execution/reconciliation.json').open('x') as stream:
    json.dump(result, stream, indent=2); stream.write('\n')
print(json.dumps(result))
