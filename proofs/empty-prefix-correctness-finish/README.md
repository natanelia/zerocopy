# Finish the remaining ordinary correctness checks

This packet prepares a continuation of [run 38668352050](https://github.com/natanelia/zerocopy/actions/runs/38668352050), attempt 1. The exact candidate is still pinned main `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e` plus the reviewed empty-prefix guard and v2 regression tests. No production source or test changes are included.

## Retained evidence and stop

The first hosted gate passed native build, portable build, declarations, all 1,063 Vitest cases in 51 files (including eight focused cases), and all six documentation-script tests. Its next command, the unchanged documentation link checker, exited 1 because it runs `git ls-files -z *.md` and the archive-materialized candidate had no Git metadata. Seven later checks remained unrun. Its `complete=false` result, exact failure, raw full-suite pass and artifact hashes remain fixed in `prior-evidence.json`. This setup failure is not a runtime test assertion failure.

The earlier focused gate passed 32 case executions across both arms and engines. The five local type checks also remain applicable under the same source/toolchain pins. The original local RSS stop and failed hosted gate are preserved; neither supplies a memory-regression or performance conclusion.

## Isolated Git context

After materializing main plus the unchanged patch, the controller initializes an isolated Git directory with an empty template and empty hooks directory. It disables system/global Git configuration and inherited Git-directory/index overrides. It adds exactly the 503 manifest-listed source paths to the index, including already tracked paths that match ignore rules, then checks every indexed path, stage and Git blob hash against the authenticated source bytes. No source commit or branch ref is created and no remote is configured or updated.

The index is created before dependencies or generated outputs are linked into the candidate. The uploaded workflow/proof packet is outside that candidate and cannot enter its tracked Markdown inventory. The index, HEAD and configuration are frozen by hash and retained with the exact source-index record. Existing repository scripts run unchanged.

## Preparation and eight remaining checks

The pinned official workflow/bootstrap, Node 22.16.0, Bun 1.4.2, lockfile and actual executable authentication are retained. Fresh native, portable and declaration builds provide required generated entry points in the new isolated workspace. They are preparation only, recorded separately from check results; all 66 outputs must match the prior authenticated candidate bytes. Native build inputs remain unchanged, and embedded portable core bytes must match authenticated native output.

Only these eight checks run, sequentially:

1. Documentation links, 60 seconds
2. Documentation examples, 90 seconds
3. Node worker integration, 60 seconds
4. Node Redux integration, 60 seconds
5. Node typed-JSON worker integration, 60 seconds
6. Package dry run, 60 seconds
7. Package archive, 60 seconds
8. Existing package consumer check, 180 seconds

The full suite and documentation-script unit tests do not rerun. Their success carries forward only through the exact source, generated, executable and retained-result pins. Package consumption remains offline after locked bootstrap; a cache miss stops the gate.

The existing finite budgets remain: 1,500 seconds for the controller, preparation capped at 300 seconds including prerequisite builds, correctness capped at 1,200 seconds and clipped to reserve 60 seconds for cleanup/preservation, and 35 minutes for the whole workflow. Every child retains its original command cap and sampled 4 GiB group-RSS guard; startup requires at least 5 GiB available memory. This is not a hard cgroup cap or performance measurement.

The reviewed ownership cleanup and attempted/started/unrun accounting remain unchanged. The first failure stops execution, with logs, receipts, source/generated/index manifests, package evidence and cleanup results retained. No retry or repair occurs automatically. Preparation does not authorize publication or execution, and this scope does not clear every additional CI proof, browser check, historical limitation, performance claim or PR/release.
