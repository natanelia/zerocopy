# Held SharedMap hosted validation

This source packet has not been published or activated. Publication requires independent review of the exact tree and coordinator release. A single push to the reviewed validation branch starts one run; GITHUB_RUN_ATTEMPT must be 1. No automatic rerun, resampling, limit extension, merge, or production deployment is authorized.

## Purpose and source

The local October 11 attempt stopped before a benchmark child started. Its cgroup membership was v2 `/`, with no matching cgroup mounts in the visible mount table. The local browser transfer returned HTML describing an unavailable site instead of the official archive. Those failures remain preserved and are not results of this prospective hosted run.

The validation branch contains the exact 512-file composition on main d856ff0bd41745ae0e84d9d726d6aaaf7013fc25 plus this temporary workflow/controller packet. A later final PR excludes the temporary hosted controls and includes the separately reviewed successful raw results and charts. Source hashes, the actual validation commit and the eventual PR commit remain distinct.

Use official actions/setup-node with Node22.23.3 and oven-sh/setup-bun with Bun1.4.2, matching the existing toolchain. Root dependency versions remain unchanged. Build portable dist afresh in the hosted checkout. Before recording, compare every root TypeScript/JSON Git blob with the current-main baseline; pin all measured proof/adapters, every generated dist JS module, dependency distributions, controllers, workflow, plan and exact Node executable. sourceCommit and runtimeSourceCommit identify the actual hosted validation commit.

## Early preflight and unchanged recording

Run the separately reviewed v2 root-proof successor of full-memory-headroom immediately after checkout and Node setup, before dependency installation, builds or browser installation. Preserve exact raw strings read and the parsed observation. The preflight requires at least3GiB effective headroom. Hosted applicability is unknown: missing mounts, unavailable counters, or an ambiguous root remain hard failures. No mount, cgroup, namespace, security setting or assumption is changed to force a pass. The full controller repeats the same live preflight at launch and observes headroom throughout recording.

The full recording keeps the reviewed workload:100,000 feature IDs,20% Unicode names,1,000 sparse lookups with910hits/90misses,100 replacements per revision, retained initial/current roots, release and10 updates. Four map representations ×0/2/4 readers ×3 fresh trials produce exactly36 processes and60 lifecycle groups. Every current/retained answer and publication/lifecycle invariant must match the independent reference. No favorable-result threshold is used.

The full-controller shell changes only hosted paths, exact source/runtime provenance, and hosted one-attempt assertions. Its headroom helper has the narrow separately reviewed root proof described below. All workload and accounting code is unchanged. Whole recording cap20minutes; process-group RSS cap2GiB; combined evidence cap256MiB; minimum reserve1GiB with3GiB preflight;500ms observations;5seconds cleanup observation. Internal calibration/RPC/case limits remain60/60/180seconds. Signed post-GC heap and tracked-buffer components, unique shared capacity, overlapping arena-used bytes and separate RSS retain their original definitions. Missing terminal evidence or a failed guard makes the attempt chart-ineligible.

## Sequential validation and evidence

The recording job has a30-minute total timeout for setup, the20-minute controller and receipt upload. Failed preflight or controller evidence is uploaded when possible. Only a complete verified matrix with clean external terminal receipt is copied under proofs/results/feature-map-memory/hosted-<run-id>/; the original importer binds summary/terminal hashes and creates the three real SVGs and feature-memory-data.json.

A second job depends on the verified recording. It downloads those exact chart inputs, uses the same source commit, and runs the ordinary existing site prerequisites, root/prefix static tests, PR35 docs-browser and package/Vite starter gates, feature workers/mobile/exports, historical routes, and isolation/browser regressions. Strict Markdown preservation uses the current-main baseline. Its20-minute job cap is the existing documentation gate cap. Browser installation uses the existing official Playwright command; no alternate CDN/proxy/route is introduced. Root and repository-prefix site/screenshots are retained separately for direct visual inspection. The actual commit-preview prefix remains mandatory in the eventual PR's ordinary exact-head CI.

The workflow has read-only repository permissions and no publish/deploy job. It produces evidence and previewable artifacts only. Completion requires independent recording/accounting/source audit, browser export and screenshot review, then a final PR whose exact-head ordinary CI and hosted artifacts pass. No local failure, historical recording or smoke is relabeled as this full measurement.

## Narrow v2 root-proof correction

Linux marks cgroup.type and cgroup.events CFTYPE_NOT_ON_ROOT and tests the actual cgroup_parent() when exposing them. Namespace path '/' alone is not a root proof. The successor requires a resolved cgroup2 mount with hierarchy root '/', readable valid cgroup.controllers including memory, cgroup.subtree_control, and cgroup.stat; BOTH cgroup.type/events and BOTH memory.max/current must be absent with ENOENT. Any present marker, partial pair, permission/IO failure, malformed mandatory file, or mount obscuring the selected root/observed files fails. A proved actual root is recorded as unconstrained without invented memory counters. All non-root owner/ancestor max/current reads remain mandatory and the minimum headroom remains in force. v1 is rejected because its numeric root counters do not prove hidden ancestry. No-memory-membership mode requires a fully parsed membership with neither v1 memory nor v2 and no memory hierarchy mount.

Pinned upstream basis: https://raw.githubusercontent.com/torvalds/linux/v6.8/kernel/cgroup/cgroup.c and https://raw.githubusercontent.com/torvalds/linux/v6.8/Documentation/admin-guide/cgroup-v2.rst . The stopped local helper, exact failed terminal and earlier fixtures remain unchanged outside this hosted packet. Hosted compatibility is still conditional on this proof; no new live probe or recording is authorized by this source file.
