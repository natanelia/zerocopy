"""Official GitHub CLI retrieval; only this setup child receives GH_TOKEN."""
import os
from pathlib import Path
import subprocess
import sys

from bounded_process import read, require, sha, write
from files import MAX_BYTES


def main():
    binding, output = read(sys.argv[1]), Path(sys.argv[2])
    require(binding['repository'] == 'natanelia/zerocopy', 'Unexpected repository')
    require(isinstance(binding['runId'], int) and isinstance(binding['artifactId'], int), 'Exact GitHub input IDs required')
    require(os.environ.get('GH_TOKEN'), 'Ephemeral Actions download token required')
    output.mkdir(mode=0o700)
    prefix = 'repos/natanelia/zerocopy/actions/'
    for label, endpoint in [('run', prefix + 'runs/' + str(binding['runId'])),
                            ('artifact', prefix + 'artifacts/' + str(binding['artifactId']))]:
        with (output / (label + '.json')).open('xb') as stream:
            subprocess.run(['gh', 'api', endpoint], stdout=stream, check=True)
    run, artifact = read(output / 'run.json'), read(output / 'artifact.json')
    require(run['id'] == binding['runId'] and run['head_sha'] == binding['sourceCommit'] and
            run['status'] == 'completed' and run['conclusion'] == 'success' and run['run_attempt'] == 1,
            'Artifact run is not the exact successful single attempt')
    require(artifact['id'] == binding['artifactId'] and artifact['name'] == binding['artifactName'] and
            artifact['workflow_run']['id'] == binding['runId'] and artifact['workflow_run']['head_sha'] == binding['sourceCommit'] and
            artifact['expired'] is False and artifact['size_in_bytes'] <= MAX_BYTES and
            artifact['digest'] == 'sha256:' + binding['artifactZipSHA256'], 'Artifact identity/digest mismatch')
    destination = output / 'artifact.zip'
    with destination.open('xb') as stream:
        subprocess.run(['gh', 'api', prefix + 'artifacts/' + str(binding['artifactId']) + '/zip'], stdout=stream, check=True)
    require(destination.stat().st_size <= MAX_BYTES and sha(destination) == binding['artifactZipSHA256'], 'Downloaded artifact mismatch')
    write(output / 'download.json', {'runId': run['id'], 'artifactId': artifact['id'],
          'sha256': sha(destination), 'bytes': destination.stat().st_size, 'officialGitHubArtifact': True})


if __name__ == '__main__':
    main()
