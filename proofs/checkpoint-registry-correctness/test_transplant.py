"""Temporarily use candidate regression text against the unchanged baseline runtime."""
from contextlib import contextmanager
import hashlib
import stat

from bounded_process import require, sha

MAX_TEST_BYTES = 128 * 1024


def identity(path):
    metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode), 'Test transplant requires a regular file')
    return metadata.st_dev, metadata.st_ino


def bounded_bytes(path):
    require(path.stat().st_size <= MAX_TEST_BYTES, 'Test transplant source exceeds finite size bound')
    data = path.read_bytes()
    require(len(data) <= MAX_TEST_BYTES, 'Test transplant source exceeds finite size bound')
    return data


@contextmanager
def transplanted_test(baseline, candidate, original_sha, candidate_sha, receipt):
    original_identity = identity(baseline)
    identity(candidate)
    original, replacement = bounded_bytes(baseline), bounded_bytes(candidate)
    require(hashlib.sha256(original).hexdigest() == original_sha, 'Baseline test source mismatch before transplant')
    require(hashlib.sha256(replacement).hexdigest() == candidate_sha, 'Candidate test source mismatch before transplant')
    receipt.update(originalSha256=original_sha, transplantedSha256=candidate_sha,
                   installed=False, restored=False, maximumTestBytes=MAX_TEST_BYTES)
    primary_failure = False
    try:
        require(identity(baseline) == original_identity, 'Baseline test identity changed before transplant')
        baseline.write_bytes(replacement)
        require(sha(baseline) == candidate_sha, 'Transplanted test source mismatch')
        receipt['installed'] = True
        yield
        require(identity(baseline) == original_identity and sha(baseline) == candidate_sha,
                'Transplanted test source changed during validation')
    except BaseException:
        primary_failure = True
        raise
    finally:
        try:
            require(identity(baseline) == original_identity, 'Baseline test identity changed before restoration')
            baseline.write_bytes(original)
            require(sha(baseline) == original_sha, 'Baseline test source restoration mismatch')
            receipt['restored'] = True
        except BaseException as error:
            receipt['restorationError'] = {'errorType': type(error).__name__,
                                           'error': 'Baseline test restoration did not complete',
                                           'primaryFailurePreserved': primary_failure}
            if not primary_failure:
                raise
