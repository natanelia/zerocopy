"""Pure deterministic transformations only; no processes, target imports or clocks."""
import copy
import json
from pathlib import Path
import unittest

import compose as c


def fixture():
    release=json.loads((Path(__file__).resolve().parents[2]/'native-reader-bindings/SCREEN-RELEASE.json').read_text())
    release.update(sealed=True,authorized=True,authorizationReference='synthetic authority only')
    release['supportFiles'][c.REVIEW]='1'*64
    t=release['transportBinding']
    t.update(sealed=True,authorizationReference=release['authorizationReference'],runId=1,artifactId=2,
             artifactName='synthetic',artifactZipSHA256='2'*64,artifactFiles={'synthetic.json':'3'*64},
             sourceCommit='4'*40,finalStudyHostExclusive=True,preparationPrefix='prepared',preparationReceiptSHA256='5'*64,
             readyInputArchiveSHA256='6'*64,readyInputInventorySHA256='7'*64,performanceReviewSHA256='1'*64,readyInputRegularBytes=1)
    prep={key:t[key] for key in ('readyInputArchiveSHA256','readyInputInventorySHA256')}
    review={**prep,'reviewedTransportMethodSHA256':t['reviewedTransportMethodSHA256'],'checks':{'boundedTransportReviewed':True}}
    receipt={**prep,'schemaVersion':1,'kind':'native-reader-performance-transport','status':'complete','bounded':True,
             'noRebuild':True,'noTargetImports':True,'extractionVerified':True,'ownedGroupsEmpty':True,
             'preparationReceiptSHA256':t['preparationReceiptSHA256'],'reviewedTransportMethodSHA256':t['reviewedTransportMethodSHA256'],
             'elapsedSeconds':1,'wholeCapSeconds':180,'rawEvidenceSealSHA256':'8'*64}
    return release,prep,review,receipt


class CompositionTests(unittest.TestCase):
    def test_transport_changes_only_documented_absolute_review_path(self):
        release,_,_,_=fixture(); before=copy.deepcopy(release)
        result=c.transport_binding(release,Path('/checkout'))
        expected={**release['transportBinding'],'performanceReviewPath':'/checkout/'+c.REVIEW}
        self.assertEqual(result,expected);self.assertEqual(release,before)

    def test_unresolved_unknown_and_traversal_rejected(self):
        for field,value in [('sealed',False),('authorized',False),('wholeStudySeconds',901),('unknown',True)]:
            release,_,_,_=fixture();release[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):c.validate_release(release)
        for path in ('../review.json','/tmp/review.json','native-reader-bindings/../review.json'):
            release,_,_,_=fixture();release['transportBinding']['performanceReviewPath']=path
            with self.subTest(path=path),self.assertRaises(ValueError):c.validate_release(release)
        release,_,_,_=fixture();release['transportBinding']['preparationPrefix']='../escape'
        with self.assertRaises(ValueError):c.validate_release(release)
        release,_,_,_=fixture();release['transportBinding']['unknown']='change'
        with self.assertRaises(ValueError):c.validate_release(release)

    def test_fresh_receipt_only_dynamic_digest_and_fixed_paths(self):
        release,prep,review,receipt=fixture();before=copy.deepcopy(release)
        manifest,approval=c.performance_documents(release,Path('/checkout'),Path('/runner'),receipt,'9'*64,review,prep)
        self.assertEqual(manifest['transportReceiptSHA256'],'9'*64)
        self.assertEqual(manifest['preparationReceiptSHA256'],release['transportBinding']['preparationReceiptSHA256'])
        self.assertEqual(manifest['proofFiles'],release['performanceProofFiles'])
        self.assertEqual(manifest['correctnessEvidenceRoot'],'/runner/native-reader-transport-output/ready/correctness')
        self.assertEqual(manifest['runtimePaths']['node'],'/runner/native-reader-transport-output/ready/runtimes/node')
        self.assertEqual(manifest['transportMethodPath'],'/runner/native-reader-transport-output/raw/transport-method.json')
        self.assertEqual(approval['maximumGroups'],80);self.assertEqual(approval['wholeStudySeconds'],900)
        self.assertEqual(release,before)

    def test_changed_scientific_review_or_receipt_pins_rejected(self):
        for field in ('readyInputArchiveSHA256','readyInputInventorySHA256','reviewedTransportMethodSHA256'):
            release,prep,review,receipt=fixture();review[field]='0'*64
            with self.subTest(field=field),self.assertRaises(ValueError):
                c.performance_documents(release,Path('/checkout'),Path('/runner'),receipt,'9'*64,review,prep)
        release,prep,review,receipt=fixture();receipt['preparationReceiptSHA256']='0'*64
        with self.assertRaises(ValueError):c.performance_documents(release,Path('/checkout'),Path('/runner'),receipt,'9'*64,review,prep)


if __name__=='__main__':unittest.main(verbosity=2)
