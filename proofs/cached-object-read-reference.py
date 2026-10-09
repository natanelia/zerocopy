"""Download immutable correctness references and safely extract verified evidence.
Authenticated GitHub requests never follow redirects. Artifact redirect URLs are
validated and fetched in a separate request with no Authorization header.
"""
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import pathlib
import re
import sys
import tarfile
import zipfile

PINS = {
    "baseline": ("3773c6e519c7c0958da13727ed1082f449f3ee25", 11587173074,
                 "70f25b19d91e1acc8f9765b43e84e175fe4b9499e21854f2a2fce3d82d878b85"),
    "candidate": ("e249dd4148211dfec0e439ea5988af041c446e94", 11587512162,
                  "921ca83f41c56e4c76031cd9dc702d054594fba7e21fade3dc94e37c2fb00586"),
}
PROOF = "8b224ead5f275358dbd4081a5795e6c0fd7e76c1"
RUN = 37863609752
MAX_BYTES = 512 * 1024 * 1024

def digest(data):
    return hashlib.sha256(data).hexdigest()

def safe_parts(name):
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or not path.parts:
        raise ValueError("unsafe archive path: " + name)
    return path.parts

def write_new(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(data)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect())

def api_request(path):
    token = os.environ["GH_TOKEN"]
    return urllib.request.Request("https://api.github.com/repos/natanelia/zerocopy/" + path,
                                  headers={"Authorization": "Bearer " + token,
                                           "Accept": "application/vnd.github+json",
                                           "X-GitHub-Api-Version": "2022-11-28"})

def api_json(path):
    # An unexpected redirect is an error; credentials never leave api.github.com.
    with opener.open(api_request(path), timeout=60) as response:
        data = response.read(2 * 1024 * 1024 + 1)
        assert len(data) <= 2 * 1024 * 1024
        return json.loads(data)

def artifact_bytes(artifact_id):
    try:
        response = opener.open(api_request("actions/artifacts/" + str(artifact_id) + "/zip"), timeout=60)
    except urllib.error.HTTPError as error:
        assert error.code == 302, "unexpected artifact API response"
        location = error.headers.get("Location")
        assert location
        parsed = urllib.parse.urlsplit(location)
        assert parsed.scheme == "https" and not parsed.username and not parsed.password
        assert parsed.port in (None, 443)
        host = (parsed.hostname or "").lower()
        assert (host.endswith(".blob.core.windows.net") or host.endswith(".githubusercontent.com")
                or host.endswith(".actions.githubusercontent.com")), "unexpected artifact download host"
        # New request, explicitly no token/header forwarding and no redirects.
        response = opener.open(urllib.request.Request(location), timeout=60)
    with response:
        data = response.read(MAX_BYTES + 1)
        assert len(data) <= MAX_BYTES
        return data

if len(sys.argv) == 5 and sys.argv[1] == "--validate-activation":
    run_id, commit, destination = sys.argv[2:]
    assert run_id.isdigit() and int(run_id) > 0 and re.fullmatch("[0-9a-f]{40}", commit)
    checked = api_json("actions/runs/" + run_id)
    assert checked["id"] == int(run_id) and checked["head_sha"] == commit
    assert checked["status"] == "completed" and checked["conclusion"] == "success"
    assert checked["run_attempt"] == 1 and checked["event"] == "push"
    assert checked["path"] == ".github/workflows/cached-object-read-performance.yml"
    jobs = api_json("actions/runs/" + run_id + "/attempts/1/jobs?per_page=100")
    assert jobs["total_count"] == 1 and len(jobs["jobs"]) == 1
    job = jobs["jobs"][0]
    assert job["run_id"] == int(run_id) and job["head_sha"] == commit
    assert job["name"] == "gate" and job["status"] == "completed" and job["conclusion"] == "success"
    steps = job["steps"]
    for name in ["Resolve one-time prospective measurement intent",
                 "Retrieve and verify immutable correctness references",
                 "Rebuild pinned sources with the original dependency lock",
                 "Validate protocol and all public-get fixtures before any timing"]:
        matches = [step for step in steps if step["name"] == name]
        assert len(matches) == 1 and matches[0]["conclusion"] == "success", "prior checks did not execute: " + name
    timing = [step for step in steps if step["name"] == "Run independently reviewed frozen campaign once"]
    assert len(timing) == 1 and timing[0]["conclusion"] == "skipped", "prior run must be checks-only"
    write_new(pathlib.Path(destination + ".jobs.json"), (json.dumps(jobs, indent=2) + "\n").encode())
    write_new(pathlib.Path(destination), (json.dumps(checked, indent=2) + "\n").encode())
    print(json.dumps({"verified": True, "validatedCheckCommit": commit, "validatedCheckRun": int(run_id)}))
    sys.exit(0)

role, zip_arg, out_arg = sys.argv[1:]
source, artifact_id, zip_digest = PINS[role]
archive_path = pathlib.Path(zip_arg)
out = pathlib.Path(out_arg)
out.mkdir(parents=True, exist_ok=False)
run = api_json("actions/runs/" + str(RUN))
assert run["id"] == RUN and run["head_sha"] == PROOF
assert run["status"] == "completed" and run["conclusion"] == "success" and run["run_attempt"] == 1
artifact = api_json("actions/artifacts/" + str(artifact_id))
assert artifact["id"] == artifact_id and artifact["expired"] is False
assert artifact["workflow_run"]["id"] == RUN
assert artifact["workflow_run"]["head_sha"] == PROOF
write_new(out / "correctness-run.json", (json.dumps(run, indent=2) + "\n").encode())
write_new(out / "artifact-metadata.json", (json.dumps(artifact, indent=2) + "\n").encode())
zip_bytes = artifact_bytes(artifact_id)
write_new(archive_path, zip_bytes)
assert len(zip_bytes) <= MAX_BYTES
assert digest(zip_bytes) == zip_digest, "frozen correctness ZIP digest mismatch"
expected = {"cached-object-evidence.tar.gz", "cached-object-evidence.sha256"}
with zipfile.ZipFile(archive_path) as archive:
    entries = archive.infolist()
    assert len(entries) == 2
    assert {item.filename for item in entries} == expected
    assert sum(item.file_size for item in entries) <= MAX_BYTES
    for item in entries:
        safe_parts(item.filename)
        assert not item.is_dir()
        assert (item.external_attr >> 16) & 0o170000 != 0o120000, "ZIP symlink rejected"
        write_new(out / item.filename, archive.read(item))
tar_path = out / "cached-object-evidence.tar.gz"
checksum = (out / "cached-object-evidence.sha256").read_text().strip().split()
assert len(checksum) == 2 and re.fullmatch("[0-9a-f]{64}", checksum[0])
assert pathlib.PurePosixPath(checksum[1].lstrip("*")).name == tar_path.name
assert digest(tar_path.read_bytes()) == checksum[0], "inner evidence archive digest mismatch"
seen = set()
total = 0
with tarfile.open(tar_path, "r:gz") as archive:
    for member in archive:
        parts = safe_parts(member.name)
        assert parts[0] == "cached-object-evidence"
        assert member.name not in seen
        seen.add(member.name)
        assert member.isdir() or member.isfile(), "links and special tar entries rejected"
        total += member.size
        assert total <= MAX_BYTES
        target = out.joinpath(*parts)
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            stream = archive.extractfile(member)
            assert stream is not None
            data = stream.read(MAX_BYTES + 1)
            assert len(data) == member.size
            write_new(target, data)
evidence = out / "cached-object-evidence"
manifest = json.loads((evidence / "source-manifest.json").read_text())
assert manifest["baseline"] == PINS["baseline"][0]
assert manifest["candidate"] == PINS["candidate"][0]
assert manifest["proofCommit"] == PROOF
assert (evidence / "source-sha.txt").read_text().strip() == source
assert digest((evidence / "arena.ts").read_bytes()) == manifest["inputs"][source]["arena.ts"]
assert digest((evidence / "cached-object-read.test.ts").read_bytes()) == manifest["inputs"][PINS["candidate"][0]]["cached-object-read.test.ts"]
assert (evidence / "node-version.txt").read_text().strip() == "v22.23.3"
assert (evidence / "bun-version.txt").read_text().strip() == "1.4.2"
assert (evidence / "expected-slot-count.txt").read_text().strip() == ("3" if role == "baseline" else "1")
dist = [[str(path.relative_to(evidence / "dist")), digest(path.read_bytes())]
        for path in sorted((evidence / "dist").rglob("*")) if path.is_file()]
assert dist and any(name == "shared.js" for name, _ in dist)
wasm = []
for line in (evidence / "root-wasm-sha256.txt").read_text().splitlines():
    sha, name = line.split(maxsplit=1)
    assert re.fullmatch("[0-9a-f]{64}", sha)
    wasm.append([pathlib.PurePosixPath(name.lstrip("*")).name, sha])
compiler = (evidence / "compiler-sha256.txt").read_text().strip().split()[0]
assert re.fullmatch("[0-9a-f]{64}", compiler)
assert (evidence / "bun.lock").is_file(), "frozen text Bun lockfile is required"
for name in ["build-wasm", "build-browser", "build-types", "full-tests",
             "built-worker-tasks", "cached-object-real-workers", "package"]:
    assert (evidence / (name + ".log")).stat().st_size > 0
receipt = {
    "role": role, "sourceSha": source, "correctnessProof": PROOF, "correctnessRun": RUN,
    "artifactId": artifact_id, "zipSha256": zip_digest, "tarSha256": checksum[0],
    "dist": dist, "wasm": sorted(wasm), "compilerImplementationSha256": compiler,
    "lockSha256": digest((evidence / "bun.lock").read_bytes()),
    "sourceManifestSha256": digest((evidence / "source-manifest.json").read_bytes()),
}
write_new(out / "receipt.json", (json.dumps(receipt, indent=2) + "\n").encode())
print(json.dumps({"verified": True, "role": role, "artifactId": artifact_id, "zipSha256": zip_digest}))
