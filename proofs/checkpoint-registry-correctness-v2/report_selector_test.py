"""Pure-Python selector and command-plan checks; imports no target modules."""
from pathlib import Path

from command_plan import command_plan
from run import FOCUSED, validate_focused_report

EXPECTED = {'redux-checkpoint.test.ts', 'checkpoint-descriptor-validation.test.ts'}


def synthetic_report(names):
    return {'success': True, 'numTotalTests': 152, 'numPassedTests': 152, 'numFailedTests': 0,
            'testResults': [{'name': '/synthetic/source/' + name} for name in sorted(names)]}


def reject(report, message):
    try:
        validate_focused_report(report, EXPECTED)
    except ValueError as error:
        assert str(error) == message
    else:
        raise AssertionError('Invalid report accepted')


def main():
    assert set(FOCUSED) == EXPECTED and len(FOCUSED) == 2
    valid = synthetic_report(EXPECTED)
    validate_focused_report(valid, EXPECTED)
    reject(synthetic_report(EXPECTED - {'redux-checkpoint.test.ts'}), 'Focused checkpoint suite coverage mismatch')
    reject(synthetic_report(EXPECTED | {'unrelated.test.ts'}), 'Focused checkpoint suite coverage mismatch')
    reject({**valid, 'success': False, 'numFailedTests': 1}, 'Focused checkpoint semantic tests did not pass')
    reject({**valid, 'numTotalTests': 0, 'numPassedTests': 0}, 'Focused checkpoint semantic tests did not pass')
    paths = [Path('/synthetic') / name for name in ['baseline', 'candidate', 'output']]
    plan = command_plan('/official/bun', '/official/node', '/official/npm', *paths)
    labels = [row[0] for row in plan]
    assert len(plan) == len(set(labels)) == 20
    assert labels[:10] == [arm + '-' + suffix for arm in ['baseline', 'candidate']
                           for suffix in ['build-wasm', 'build-browser', 'build-types', 'typecheck', 'typecheck-redux']]
    assert labels[10:18] == [arm + '-' + suffix for arm in ['baseline', 'candidate']
                            for suffix in ['focused-node', 'focused-bun', 'full-bun', 'redux-proof']]
    assert labels[18:] == ['candidate-package-dry-run', 'candidate-package-consumer']
    for label, argv, root, wall in plan:
        if '-focused-' in label:
            assert {name for name in argv if name.endswith('.test.ts')} == EXPECTED
            assert wall == 120
            assert argv[:2] == (['/official/bun', '--bun'] if label.endswith('-bun')
                                else ['/official/node', 'node_modules/vitest/vitest.mjs'])
            assert argv[-1] == '--outputFile=' + str(paths[2] / (label + '.json'))
        if label.endswith('-full-bun'):
            assert argv == ['/official/bun', 'run', 'test'] and wall == 600
        assert root == (paths[0] if label.startswith('baseline-') else paths[1])
    print('Selector and plan regression passed: both checkpoint files; missing/extra/failed/empty rejection; 20 exact ordered targets.')


if __name__ == '__main__':
    main()
