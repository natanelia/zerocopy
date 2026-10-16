"""Pure-Python report-shape regression; imports no repository target modules."""
from run import FOCUSED, validate_focused_report


BASELINE_FILES = {
    'block-traversal-view.test.ts', 'checkpoint-descriptor-validation.test.ts',
    'descriptor-validation.test.ts', 'worker-attachment.test.ts',
    'worker-records.test.ts', 'worker.test.ts',
}


def synthetic_report(names):
    return {
        'success': True, 'numTotalTests': 233, 'numPassedTests': 233, 'numFailedTests': 0,
        'testResults': [{'name': '/synthetic/source/' + name} for name in sorted(names)],
    }


def expect_rejection(report, expected, message='Focused Node suite coverage mismatch'):
    try:
        validate_focused_report(report, expected)
    except ValueError as error:
        assert str(error) == message
    else:
        raise AssertionError('The invalid report or expected file set was accepted')


def main():
    assert set(FOCUSED) == BASELINE_FILES
    original = BASELINE_FILES - {'checkpoint-descriptor-validation.test.ts'}
    baseline = synthetic_report(BASELINE_FILES)
    expect_rejection(baseline, original)
    validate_focused_report(baseline, set(FOCUSED))

    candidate_files = BASELINE_FILES | {'native-reader.test.ts'}
    candidate = synthetic_report(candidate_files)
    # Counts are synthetic: only the baseline's recorded aggregate is reproduced.
    candidate.update(numTotalTests=234, numPassedTests=234)
    expect_rejection(candidate, original | {'native-reader.test.ts'})
    validate_focused_report(candidate, set(FOCUSED) | {'native-reader.test.ts'})
    expect_rejection(synthetic_report(BASELINE_FILES - {'worker.test.ts'}), set(FOCUSED))
    expect_rejection(synthetic_report(BASELINE_FILES | {'unexpected.test.ts'}), set(FOCUSED))
    expect_rejection({**baseline, 'success': False, 'numFailedTests': 1}, set(FOCUSED),
                     'Focused Node semantic tests did not pass')
    expect_rejection({**baseline, 'numTotalTests': 0, 'numPassedTests': 0}, set(FOCUSED),
                     'Focused Node semantic tests did not pass')
    print('Report selector regression passed: six-/seven-file acceptance; original-set, missing, extra, failed, and zero-test rejection.')


if __name__ == '__main__':
    main()
