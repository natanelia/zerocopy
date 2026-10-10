# Validation dependencies and runtime provenance

Status: source-only preparation, 2026-10-10. No package installation, application
import, build, test, browser launch, calibration, timing, publication or hosted
dispatch was performed in preparing this document. Commands below are a future
preflight contract, not evidence that they passed. Hosted execution requires its
separate release.

## Frozen-install input

`toolchain/package.json` and `toolchain/bun.lock` are byte-for-byte copies of the
retained validation dependency pair. The full original manifest is intentionally
retained to preserve the lock's root dependency/optional-peer contract; it is
used only as a validation dependency installation directory. Its application
exports and build/publish scripts are not preparation instructions and must not
be invoked. No installed dependency tree or downloaded executable is included.

| Input | SHA256 |
| --- | --- |
| `toolchain/package.json` | `f2fe4346febbcb1284e50696fefac4498660fa7bed438b4f857dd3b3aba479a9` |
| `toolchain/bun.lock` | `c7f59c139a7bdcb80941f0951aee705d30d606d699f08d2ab4600cf5f5cc128e` |

Static inspection found lockfileVersion 2/configVersion 1, one root workspace,
107 resolved package records, and SHA512 integrity strings for every record.
All 16 root development-dependency names/versions and both peer-dependency
constraints match the package manifest. The lock's optional peers are
`@reduxjs/toolkit` and `@tanstack/db`, matching the manifest. There are no local
path dependencies or additional workspaces. The retained installation was
created by Bun 1.4.2 with lifecycle scripts disabled; it was not a frozen ARM
installation. The lock is a validation freeze of the existing direct pins, not
an assertion that the repository historically committed this resolution.

The relevant locked versions are:

| Component | Exact version |
| --- | --- |
| Playwright and playwright-core | 1.63.0 |
| Vitest, @vitest/browser, @vitest/browser-playwright | 4.1.11 |
| Vite | 8.3.4 |
| Rolldown | 1.2.13 |
| Lightning CSS | 1.33.0 |
| TypeScript | 5.9.3 |
| bun-types | 1.4.2 |

The complete dependency inventory and package integrity strings remain in the
lock, including tools irrelevant to this narrow screen. Do not prune or resolve
it again as part of hosted setup. Node 22.23.3 satisfies the inspected package
engine declarations: Playwright >=20; Vitest ^20.0.0 || ^22.0.0 || >=24.0.0;
Vite/Rolldown ^20.19.0 || >=22.12.0; Lightning CSS >=12.0.0. These declarations
are compatibility metadata, not proof that browser correctness works under Bun.

A future setup must first verify that both manifest files exist and match their
hashes, then invoke the exact Bun 1.4.2 executable from the `toolchain` directory:

```sh
bun install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
```

Retain its command, exit status and log; verify the two input hashes afterward.
Do not omit development or optional dependencies, use production mode, bypass
integrity checking, or repair a rejected lock. Frozen acceptance on each hosted
platform is still unverified. A rejection is a preflight failure. Bun documents
that frozen mode uses the lock's versions and errors on a manifest mismatch;
`--ignore-scripts` suppresses all package lifecycle scripts. Explicitly checking
lock existence matters because current Bun documentation describes a no-lock
case that can install from the manifest. [Bun install documentation](https://bun.sh/docs/pm/cli/install)

Invoke installed CLIs by their explicit local paths. For example, from the
packet root, the future browser setup command is:

```sh
node toolchain/node_modules/playwright/cli.js install --with-deps chromium firefox webkit
```

This avoids a package-runner fallback that could obtain a different Playwright
when the intended local installation is absent. Setup is outside scientific
timing but inside the hosted job deadline. OS package installation is not frozen
by `bun.lock`; record its resulting inventory separately.

## Official runtime distributions

Exact runtime selection is Node 22.23.3 and Bun 1.4.2. Official distribution
metadata was read during preparation; no archive was downloaded or executed.
The following are publisher-reported archive digests, not hashes of extracted
executables:

| Runtime / platform | Official archive | Archive SHA256 |
| --- | --- | --- |
| Node / Linux ARM64 | `node-v22.23.3-linux-arm64.tar.xz` | `a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f` |
| Node / Linux x64 | `node-v22.23.3-linux-x64.tar.xz` | `df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de` |
| Bun / Linux ARM64 glibc | `bun-linux-aarch64.zip` | `54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7` |
| Bun / Linux x64 glibc | `bun-linux-x64.zip` | `36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913` |

Node files are under
`https://nodejs.org/download/release/v22.23.3/`; the exact filenames and
digests appear in its [official SHA256 list](https://nodejs.org/download/release/v22.23.3/SHASUMS256.txt).
Bun files are assets of [Bun v1.4.2](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2),
with the listed digests in the [official asset inventory](https://github.com/oven-sh/bun/releases/expanded_assets/bun-v1.4.2).
These are normal release/glibc builds, not profiling, Android or musl builds.
Use version-specific sources or setup actions pinned to these exact versions;
do not substitute floating Node 22 or the latest Bun release.

The source inventory establishes that official ARM64 distributions exist.
Extracted hosted runtime executable hashes, actual versions, architecture,
download receipts and runner access remain to be established during preflight.
GitHub currently lists `ubuntu-24.04-arm` as an ARM64 hosted runner label and
`ubuntu-latest` as x64, but labels and documentation do not establish repository
quota or a successful run. Record the actual image and machine metadata.
[GitHub hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

## ARM dependency inventory

The same lock includes the platform-specific optional packages below, with
resolved versions and integrity strings. Ubuntu's glibc targets are the `gnu`
entries. Keep musl entries in the unchanged lock; their presence is not an
instruction to select them on Ubuntu.

| Native dependency | ARM64 GNU | ARM64 musl | x64 GNU/musl |
| --- | --- | --- | --- |
| Rolldown binding | `@rolldown/binding-linux-arm64-gnu@1.2.13` | `@rolldown/binding-linux-arm64-musl@1.2.13` | Both at 1.2.13 |
| Lightning CSS | `lightningcss-linux-arm64-gnu@1.33.0` | `lightningcss-linux-arm64-musl@1.33.0` | Both at 1.33.0 |

The two ARM64 GNU integrity strings are:

- Rolldown: `sha512-DTpb/+jMiqWMPgphn4ksW1zW+XLJ6dJJ9FMvnIk9I291LhCctMPhMYJrP5t9p6C9qa3KXadDdUEZHBaPh3kNxQ==`
- Lightning CSS: `sha512-j2v/itmy4HlNxlc6voKXYgBqNi0Ng2LShg4z7GufpEgs05P+2suBVyi9I6YHq5uoVFx9ETin3eCEhLVyXGQnKg==`

Record installed package names/versions and SHA256 of every installed regular
file, including native `.node` files; retain symlink targets as separate
metadata. Inventory the selected native packages and their ELF architectures.
Installed file counts can legitimately differ across platforms. A retained x64
installation is not an ARM cache, ARM binary hash or ARM execution result.

## Browser pins and download provenance

The retained `playwright-core/browsers.json` has SHA256
`545d52f8382c391e605562c330e9c1c534a16045898203037a49bb8bd769a946`.
Its pinned descriptors are:

| Artifact | Revision | Browser version | Linux launch target |
| --- | --- | --- | --- |
| chromium | 1243 | 153.0.8010.12 | `chrome-linux64/chrome` (x64) |
| chromium-headless-shell | 1243 | 153.0.8010.12 | `chrome-headless-shell-linux64/chrome-headless-shell` (x64) |
| firefox | 1543 | 155.0 | `firefox/firefox` |
| webkit | 2359 | 26.6 | `pw_run.sh` wrapper |
| ffmpeg | 1011 | not declared | `ffmpeg-linux` |

The only WebKit revision overrides in this metadata are for mac14 and
mac14-arm64 (2251), irrelevant to the proposed Linux hosts. The retained
registry maps Ubuntu 24.04 ARM64 and x64 for all three engines and headless
Chromium. Browser execution in this packet remains the x64 job; these ARM
registry entries do not add browser ARM measurement cells.

Exact source-derived download paths for Ubuntu 24.04 x64 are:

- Chromium: `https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-linux64.zip`
- Chromium headless shell: `https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip`
- Firefox: `builds/firefox/1543/firefox-ubuntu-24.04.zip`
- WebKit: `builds/webkit/2359/webkit-ubuntu-24.04.zip`

Chromium uses the stated single CDN. Firefox/WebKit use the retained ordered
mirror bases `https://cdn.playwright.dev/dbazure/download/playwright`,
`https://playwright.download.prss.microsoft.com/dbazure/download/playwright`,
and `https://cdn.playwright.dev`. Their paths are selected by the actual host
platform; do not label an Ubuntu 26.04 or other-platform package as Ubuntu 24.04.
These paths come from the pinned registry source, not a claim of successful
network retrieval. Reject inherited custom download-host/platform overrides.
Playwright explains that each package version requires its corresponding browser
builds and distinguishes regular Chromium from its headless shell.
[Playwright browser documentation](https://playwright.dev/docs/browsers)

Browser package revisions do not provide browser executable hashes. The retained
download code checks HTTP status and transfer length and extracts an archive;
`browsers.json` supplies no cryptographic browser archive or executable digest.
Its temporary downloaded ZIP is removed by the installer. A package-lock
integrity string authenticates the npm package bytes, not these separately
downloaded browser binaries.

Before any measurement, capture and retain:

1. The installed Playwright/core package versions and file hashes; assert the
   `browsers.json` hash and descriptor values above. Log the selected platform,
   exact requested URL/mirror and installer exit receipt.
2. A complete SHA256 inventory of the installed browser directories, including
   wrappers, executables, engine libraries, resources and symlink targets, plus
   each actual launch executable's resolved path, size and SHA256. Exact hosted
   executable hashes are deliberately unknown until this step. Do not fill them
   with a revision, archive digest or unrelated x64 executable hash.
3. The actual live browser version, launch options/argv, and OS process identities
   and executable paths. For Chromium, an ordinary headless launch with no
   channel selects `chromium-headless-shell`; `chromium.executablePath()` alone
   may describe regular Chromium instead. For WebKit, `pw_run.sh` alone is not
   the engine binary: include actual child ELF executables and browser-tree
   libraries in the inventory.
4. A successful identity/containment receipt before measurements and unchanged
   runtime/module/dependency/browser-file hash inventories after the screen.
   Record exact OS package versions and runner image, kernel, CPU/architecture,
   memory limit and relevant sanitized launch environment. Never label this a
   hermetic host. If a browser archive SHA256 is also required, capture those
   downloaded bytes during authorized setup; the normal installer does not
   leave them available for a later hash claim.

## Process ownership evidence for controller review

The inspected installed source is `playwright-core/lib/coreBundle.js`, SHA256
`549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171`.
Its bundled source labels identify `packages/utils/processLauncher.ts` and
`packages/playwright-core/src/server/browserType.ts`. Relevant line spans in
this exact file are:

- 9312–9326: `launchProcess` spawns the browser with
  `detached: process.platform !== "win32"`. On Linux the browser leads a new
  process group, separate from a controller's process group.
- 9359–9378: process close resolves cleanup, removes registered handlers and
  invokes `onExit`; exit handling is installed, with SIGINT/SIGTERM/SIGHUP
  handling conditional on launch options.
- 9380–9434: graceful close awaits temporary-directory cleanup; repeated close
  or a failed graceful attempt force-kills. Linux force-kill is
  `process.kill(-spawnedProcess.pid, "SIGKILL")`, targeting the browser group.
  The kill helper then waits for cleanup. Errors killing a group are logged.
- 9260–9297: normal exit invokes registered kill callbacks; SIGTERM/SIGHUP start
  graceful closing. A controller killed with SIGKILL cannot run these handlers.
- 39792–39871: BrowserType enables those three signal handlers by default,
  retains the launched process, and implements close-or-kill with a timeout.
- 43370–43375: Chromium chooses the headless-shell executable for headless mode
  with no explicit channel.
- 32376–32414 and 32534–32604: browser download retry/cleanup and transfer-length
  checks; temporary archives are removed. Setup download retries are not
  replacement scientific subjects and must remain within setup/job limits.
- 32652–32661, 32800–33010 and 33650–33675: CDN/path construction, executable
  mappings, platform entries and environment override handling.

A supervisor that only sums or kills its controller PGID therefore cannot
claim to own the full browser tree. The future containment mechanism must cover
the controller plus every detached browser group and descendant, retain PID
start identities against reuse, and verify cleanup before advancing. An owned
subtree/cgroup can cover descendants across `setsid`; a process-discovery design
needs an explicit solution for reparenting and browser creation races. Preserve
the actual aggregate RSS scope and all cleanup/timeout receipts. This source
review does not demonstrate containment on a hosted machine and supplies no
controller implementation.

## Remaining preflight decisions

The exact package/lock pair and official runtime ARM availability are resolved
at source level. Hosted frozen installation, selected native binaries, browser
availability/shared-memory isolation, runner access, actual executable hashes,
and containment remain unverified. The preflight must reject mismatches and
retain the failure. Do not update pins, silently skip an engine, rebuild the
audited runtime subjects, add calibration attempts or substitute a newer main
as a setup repair.
