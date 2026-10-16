"""Restore one independently reviewed ready archive without executing its bytes."""
from pathlib import Path
import shutil
import sys

from bounded_process import read, require, sha, write
from files import relative, unzip_exact, untar_exact, inventory, validate_inventory
from authentication import verified_json, verify_tree_seal
from scratch import cleanup


def restore(binding, work, raw):
    unzip_exact(work / 'download/artifact.zip', work / 'downloaded', binding['artifactFiles'])
    prepared = work / 'downloaded' / relative(binding['preparationPrefix'])
    receipt_path = prepared / 'preparation-receipt.json'
    receipt = verified_json(receipt_path, binding['preparationReceiptSHA256'])
    require(receipt.get('schemaVersion') == 1 and receipt.get('status') == 'complete' and receipt.get('bounded') is True and
            receipt.get('noRebuild') is True and receipt.get('noTargetImports') is True and receipt.get('ownedGroupsEmpty') is True and
            receipt.get('wholeCapSeconds') == 600 and type(receipt.get('elapsedSeconds')) in (int, float) and 0 < receipt['elapsedSeconds'] <= 600,
            'Reviewed complete preparation receipt required')
    verify_tree_seal(prepared / 'raw', 'raw-evidence-seal.json', receipt['rawEvidenceSealSHA256'])
    review = verified_json(Path(binding['performanceReviewPath']), binding['performanceReviewSHA256'])
    require(review.get('schemaVersion') == 1 and review.get('kind') == 'native-reader-performance-implementation-audit' and
            review.get('independent') is True and review.get('disposition') == 'source-clear-for-exact-bound-execution' and
            review.get('preparationReceiptSHA256') == binding['preparationReceiptSHA256'] and
            review.get('methodSHA256') == binding['methodSHA256'] and
            review.get('checks', {}).get('boundedPreparationReviewed') is True and review.get('checks', {}).get('boundedTransportReviewed') is True,
            'Independent prepared-artifact and prospective transport review required')
    for field in ('readyInputArchiveSHA256', 'readyInputInventorySHA256'):
        require(receipt[field] == review[field] == binding[field], 'Preparation/review/archive binding mismatch')
    require(review['reviewedTransportMethodSHA256'] == binding['reviewedTransportMethodSHA256'], 'Reviewed recipe mismatch')
    archive, inventory_path = prepared / 'ready-inputs.tar', prepared / 'raw/ready-inventory.json'
    require(sha(archive) == binding['readyInputArchiveSHA256'] and sha(inventory_path) == binding['readyInputInventorySHA256'], 'Immutable ready inputs changed')
    expected = read(inventory_path); validate_inventory(expected, modes=True)
    # Archive permits only regular files; authenticated contained links are made last.
    untar_exact(archive, raw.parent / 'ready', expected)
    require(inventory(raw.parent / 'ready', links=True, modes=True) == expected, 'Fresh exact restoration differs')
    regular_bytes = sum((raw.parent / 'ready' / name).stat().st_size for name, row in expected.items() if 'sha256' in row)
    require(regular_bytes == receipt['readyInputRegularBytes'] == binding['readyInputRegularBytes'], 'Restored aggregate sizing differs from reviewed preparation')
    shutil.copyfile(archive, raw.parent / 'ready-inputs.tar')
    shutil.copyfile(inventory_path, raw / 'ready-inventory.json')
    shutil.copyfile(receipt_path, raw.parent / 'preparation-receipt.json')
    shutil.copyfile(receipt_path, raw / 'original-preparation-receipt.json')
    shutil.copyfile(binding['performanceReviewPath'], raw / 'performance-review.json')
    require(sha(raw.parent / 'ready-inputs.tar') == binding['readyInputArchiveSHA256'] and
            sha(raw / 'ready-inventory.json') == binding['readyInputInventorySHA256'] and
            sha(raw.parent / 'preparation-receipt.json') == binding['preparationReceiptSHA256'], 'Retained custody bytes changed')
    cleanup(work, raw, ('home', 'tmp'))
    write(raw / 'restoration.json', {'schemaVersion': 1, 'extractionVerified': True, 'noRebuild': True, 'noTargetImports': True,
        'files': len(expected), 'archiveBytes': archive.stat().st_size, 'regularBytes': regular_bytes,
        'preparationReceiptSHA256': binding['preparationReceiptSHA256'],
        'readyInputArchiveSHA256': binding['readyInputArchiveSHA256'],
        'readyInputInventorySHA256': binding['readyInputInventorySHA256'],
        'reviewedTransportMethodSHA256': binding['reviewedTransportMethodSHA256'],
        'originalPreparationRawEvidenceSealSHA256': receipt['rawEvidenceSealSHA256']})


if __name__ == '__main__':
    restore(read(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
