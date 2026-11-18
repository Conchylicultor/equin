# release-assets

What a release tag publishes for the curl install, and the contract the
three readers of it share. Design:
[`research/2026-11-17-global-installer-window.md`](../../../../research/2026-11-17-global-installer-window.md) §6–7;
the two-phase publish:
[`research/2026-11-18-global-github-release-events.md`](../../../../research/2026-11-18-global-github-release-events.md) §4.

## The workflow (`.github/workflows/installer-release.yml`)

- **On every pushed tag**; only release tags (`v<YYYY.MM.DD>[.N]`, cut by
  `./equin version cut`) go further — any other tag ends the run without
  error. **By hand** (Actions → Installer release → Run workflow, or
  `gh workflow run installer-release.yml -f ref=<tag>`): on a tag that already
  has a Release, its files are left alone and the installer is (re)attached;
  `replace` republishes the Release from scratch (as does a run finding only
  a draft, left by a publish that stopped midway); `publish` off builds any ref
  and keeps the binaries as run artifacts only (how to try a build without
  releasing).
- **Jobs**: validate (which ref, is it a release, does it have the window's
  crate, is it the newest release) → publish (below; needs only validate) and,
  in parallel, page (the installer page bundled once,
  `window/scripts/bundle-page.ts`) → macOS (`macos-15`: both architectures,
  `lipo`, then **ad-hoc signed** — lipo drops the linker's signatures and
  arm64 refuses unsigned code; `--version`, `--probe`, the x86_64 slice under
  Rosetta) and Linux (`ubuntu-22.04` x64 and `ubuntu-22.04-arm`: glibc 2.35,
  webkit2gtk-4.1; inside `dbus-run-session` — without a session bus, which
  xvfb-run does not start, WebKitGTK stalls ~30 s on D-Bus timeouts — then
  `--probe` under xvfb, the real window over a dry run (must reach "✓ Start
  equin", the last step), and `--probe` in a bare `ubuntu:22.04` container must FAIL: the
  loader refuses the binary, exit 127 — the no-webkit
  fallback) → attach (needs publish, macOS and Linux all green) →
  release-status ("Is the window attached?", runs whatever the builds did,
  once the Release exists).
- **A Release missing its window is loud**: release-status writes a warning
  block into the Release notes (between `<!-- installer-window-status -->`
  markers: which build failed, the run, the re-attach command), fails the run
  with an `::error::` (so the watch below files a `github-run-failed`
  report), and takes the block off again once a later run attaches.
- **A build that never got a runner is re-run once**: GitHub's hosted macOS
  pool can turn a job away ("not acquired by Runner … after multiple
  attempts" — the job is cancelled after ~15 min with zero steps;
  v2026.11.18.6). When every failed build job carries that annotation (read
  from its check run, so a job cancelled by hand is never mistaken for it),
  release-status dispatches the workflow again for the tag (`retried=true`,
  so at most once); it queues behind this run
  in the concurrency group, finds the Release and only attaches. A build
  that ran and failed is never re-run — that is a bug. No timeout is raised:
  the macOS build takes ~1–2 min.
- **Toolchain**: the exact bun and rust versions `mise.lock` records, installed
  directly (`setup-bun`, `rust-toolchain`) — `mise install` would also run the
  repo's postinstall hooks, meant for a developer's machine.
- **Two phases**, so an installer build failure no longer blocks the
  Release, and **files published first never change** (a client reading
  `release.json` and `SHA256SUMS` on either side of a rewrite would see a
  mismatch — why the binaries are not added to them later):
  - **publish** (~1 min after the tag): `scripts/assemble.ts --mode core`,
    from the WORKFLOW's own checkout (a manual rebuild of an older tag still
    uses today's code; the tag's `install.sh` is read with `git show`), writes
    `release.json` (`installers: 1` when the tag has the window's crate) and
    `SHA256SUMS` over install.sh + release.json; GitHub build-provenance
    records over the three (`actions/attest-build-provenance`, attached as
    `provenance.intoto.jsonl`). Published as a draft with every file, then made
    public in one edit (`--latest` only when the tag is the newest release
    tag), so `releases/latest` never names a Release still uploading. If the
    Release exists and `replace` is off, this phase does nothing (not an
    error).
  - **attach**: `assemble.ts --mode installer` writes `INSTALLER-SHA256SUMS`
    over the binaries; their provenance goes to
    `installer-provenance.intoto.jsonl`; `gh release upload --clobber` the
    binaries, then the provenance, then **`INSTALLER-SHA256SUMS` last** (a
    re-run deletes it first): its presence means every binary it lists is
    there. Until it is (or for good, when a build failed), `--window` stops,
    saying the window "isn't published (yet)" (the default terminal view never
    asks for it; under `DEFAULT_VIEW=auto`, stage 0 installs in the terminal,
    saying so).
  - `gh attestation verify <file> -R equinai/equin` checks any file.
- **A tag cut before the window** (no crate at the tag, no hand-off marker in
  its install.sh) still gets a Release — install.sh, release.json, SHA256SUMS
  — and stage 0 installs it with main's steps, in the terminal.
- **No release signature, no branch protection** (decided with the user):
  trust is SHA256SUMS (corruption, truncation, mixed releases) plus the
  provenance records. The design doc's note on signing says why.

## The contract (`core/`)

- `INSTALLER_BINARIES` — one asset per platform key stage 0 derives from
  `uname`: `macos-universal`, `linux-x64`, `linux-arm64`.
- `INSTALLER_BINARY_PREFIX` — `equin-installer-`: every binary is it plus
  its platform key (stage 0 derives a v2 release's binary name from it).
- `RELEASE_FILES` — `install.sh`, `release.json`, `SHA256SUMS` (core files),
  `INSTALLER-SHA256SUMS` (the attached binaries) — `sha256sum` format, sorted.
- `ATTACH_MARKER` — `# installer-attach: <events protocol>`: the script
  hands the steps after the clone to the checkout's own install.sh
  (`--attach`). Stage 0 reads it in the downloaded script itself (no
  manifest field): a release without it is never used to install main.
- `ReleaseManifest` (`release.json`), a union on `v`: `tag`, `commit`,
  `handoff` (1 when the tag's install.sh carries `HANDOFF_MARKER` — it
  accepts `--release` / `--checkout`), `eventsProtocol`, and
  - `v: 2` (written today): `installers` — 1 when binaries are attached
    separately (verified by `INSTALLER-SHA256SUMS`), null before the window;
  - `v: 1` (releases cut before 2026-11-18, still read): `assets` (platform →
    file), the binaries listed in `SHA256SUMS`.

  An old stage 0 reading v2 finds no platform key and installs in the
  terminal; the window's self-bootstrap reads both. Written one key per line:
  install.sh reads it with `sed`, no JSON parser.
- `releaseManifest` / `sha256Sums` — what `assemble.ts` writes; the stage-0
  test publishes its fake releases through them (v2, attached or not, and
  v1), so the bash reader and the
  TypeScript writer cannot drift.

## Readers

- **install.sh stage 0** (bash, repo root) — resolve, download, verify, pick
  the view, exec. See its header and the root `CLAUDE.md` of
  [`installer`](../../CLAUDE.md).
- **`equin-installer` self-bootstrap** (`window/rust/src/bootstrap.rs`) — the
  same fetch with no shell around it (the later double-click app).
- **`EQUIN_RELEASES_URL`** points both at another server (the stage-0 test's).

## Checks

- `release-assets:tag-grammar` — the workflow's and install.sh's
  `RELEASE_TAG_ERE` equal upstream/release's (one POSIX ERE, so bash's `=~`
  and JavaScript read the same spelling).
- `release-assets:asset-names` — the workflow builds every platform, it and
  install.sh name `INSTALLER-SHA256SUMS`, install.sh spells
  `equin-installer-$key`, and install.sh keeps its hand-off and attach
  markers, every attach-marker spelling in it equal to `ATTACH_MARKER`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Watches the release workflow on GitHub (GitHubEvents.Watch: the product repo's installer-release.yml and its Releases), so a failed release run files a report naming the re-publish command, and the releases row reads what GitHub published.
- Server:
  - Contributes: `github-events.watch` "equinai/equin installer-release.yml"
  - Uses:
    - `integrations/github-events.GitHubEvents`
    - `integrations/github-events.workflowFileOf`
- Core:
  - Uses: `installer.INSTALL_PROTOCOL_VERSION`
  - Exports (types): `InstallerPlatform`
  - Exports (values):
    - `ATTACH_MARKER`
    - `HANDOFF_MARKER`
    - `INSTALLER_BINARIES`
    - `INSTALLER_BINARY_PREFIX`
    - `INTERNAL_ARGS_MARKER`
    - `RELEASE_FILES`
    - `RELEASE_WORKFLOW`
    - `releaseManifest`
    - `sha256Sums`
- Cross-plugin:
  - Imported by: `upstream`
- Test helpers:
  - Core: `@plugins/installer/plugins/release-assets/core/testing`
    - `ReleaseManifest` — `release.json`: what one release published.

<!-- AUTOGENERATED:END -->
