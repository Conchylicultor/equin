# Tauri release: headless-safe `.app` build + self-owned `.dmg` packaging

> Status: implementation plan. Category: `cli` (the release command) + the `tauri/` shell + docs.
> Scope: fixes the headless `.dmg` failure in `./equin release --composition <name> --target tauri`.

## Context

`./equin release --composition <name> --target tauri` runs `tauri build`
(via `wrapTauri` in `plugins/framework/plugins/cli/bin/commands/release.ts:455-459`).
Tauri's macOS bundler honors `tauri.conf.json`'s `"targets": "all"`
(`tauri/src-tauri/tauri.conf.json:28`), so after it successfully builds the
runnable `<Name>.app` it proceeds to the `.dmg` step. Tauri's dmg step shells out
to its vendored `bundle_dmg.sh`, which mounts the disk image and drives **Finder
via AppleScript** to style the window (icon positions, size, background). In a
non-interactive / headless shell that AppleEvent times out
(`Finder got an error: AppleEvent timed out. (-1712)`) and the dmg step exits
non-zero — failing the **whole** release and discarding a fully-built, usable
`.app`. This is already documented as a known caveat in `tauri/README.md`.

The cosmetic dmg styling is the only thing that needs a GUI. The `.app` itself is
complete and headless-built. **Fix:** stop asking Tauri to build the dmg (it has
no headless backend and no pluggable bundler), and instead package the already-
built `.app` into a styled `.dmg` ourselves with **`appdmg`** — a Node tool that
writes the `.DS_Store` window layout **directly** (via the `ds-store` npm lib) and
assembles the image with `hdiutil`, sending **no AppleEvent to Finder**. It runs
as `bun x appdmg <spec> <out>`, matching the existing `bun x @tauri-apps/cli@2`
invocation pattern — no new Python/toolchain prerequisite, fetched on demand by
`bun x`. Intended outcome: the release runs to completion headlessly and emits
both `<Name>.app` and a styled, double-click-layout `<Name>.dmg`.

> The `.dmg` remains **unsigned / un-notarized** — identical to today. Gatekeeper
> behavior is unchanged; code-signing + notarization stays a separate follow-up.

## Approach

All changes are in `wrapTauri` (the `dev: false` / build path), platform-gated to
macOS. Linux is untouched: its default `targets: all` produces deb/rpm/AppImage,
none of which need a GUI.

### 1. Build only the `.app`, then package the dmg (macOS) — `release.ts`

In `wrapTauri` (`plugins/framework/plugins/cli/bin/commands/release.ts:421-464`),
replace the single `tauri build` call with platform-aware logic:

- **`--dev`**: unchanged — still `bun x @tauri-apps/cli@2 dev --config <override>`.
- **build, macOS (`process.platform === "darwin"`)**:
  1. `bun x @tauri-apps/cli@2 build --config <override> --bundles app` — `--bundles`
     overrides the conf `targets`, so Tauri builds `<Name>.app` and **never
     attempts its broken dmg step**.
  2. Call a new local helper `packageMacDmg(...)` (below) to produce `<Name>.dmg`.
- **build, non-macOS**: unchanged — `bun x @tauri-apps/cli@2 build --config <override>`
  (default bundles are all headless-safe on Linux).

The produced `.app` lives at
`tauri/src-tauri/target/release/bundle/macos/<productName>.app`
(`productName` is already computed at `release.ts:445-446`).

### 2. New `packageMacDmg` helper — `release.ts`

A small local function (sibling of `wrapTauri`), only invoked on macOS:

1. Resolve inputs:
   - `appPath = <srcTauri>/target/release/bundle/macos/<productName>.app`
   - `icnsPath = <srcTauri>/icons/icon.icns` (exists at build time — required by
     `tauri.conf.json` `bundle.icon`; gitignored/generated per README).
   - `dmgOut = <srcTauri>/target/release/bundle/dmg/<productName>.dmg`
     (under the already-gitignored `target/`; `mkdirSync` the `dmg/` dir).
2. Write an appdmg JSON spec to a gitignored path
   (`<srcTauri>/appdmg.spec.json`, mirroring how `tauri.conf.override.json` is
   generated + gitignored). Minimal v0 spec — no background image (cosmetic, can
   be added later):
   ```json
   {
     "title": "<productName>",
     "icon": "<icnsPath>",
     "window": { "size": { "width": 540, "height": 380 } },
     "contents": [
       { "x": 140, "y": 200, "type": "file", "path": "<appPath>" },
       { "x": 400, "y": 200, "type": "link", "path": "/Applications" }
     ]
   }
   ```
3. `rmSync(dmgOut, { force: true })` (appdmg refuses to overwrite an existing dmg),
   then `bun x appdmg@<pinned> <spec> <dmgOut>` via the existing `run()` helper
   (`release.ts:65-80`) — inherits stdio, throws loudly on non-zero exit (no
   silencing; aligns with the repo's "fail loudly" rule).
4. Update the closing log (`release.ts:462-463`) to print both the `.app` and the
   `.dmg` paths.

> Pin a known-good `appdmg` version in the `bun x appdmg@x.y.z` specifier for
> reproducibility, exactly as `@tauri-apps/cli@2` is pinned.

### 3. `.gitignore`

Add `/tauri/src-tauri/appdmg.spec.json` (the generated spec), mirroring the
existing `/tauri/src-tauri/tauri.conf.override.json` entry at `.gitignore:41`.
(`target/` is already ignored at `.gitignore:39`, covering the built dmg.)

### 4. Docs — `tauri/README.md`

Update the **`.dmg` bundling needs a GUI session** caveat: it's now resolved —
the release builds `--bundles app` and packages the dmg headlessly via `appdmg`
(no Finder/AppleScript). Note the dmg is still unsigned/un-notarized. Update the
"Status" / "How `release --target tauri` uses this project" step 4 to reflect the
two-step macOS build (`tauri build --bundles app` → `appdmg`).

## Not in scope / unaffected

- **Studio "release tauri" UI flow.** The release engine (`run-release.ts:179-196`)
  spawns the CLI with `--dev`, which runs `tauri dev` (no bundling) — so it never
  hit the dmg failure and is unchanged by this plan. (That the Studio flow runs
  `dev` rather than producing a distributable artifact is a pre-existing,
  separate design point, out of scope here.)
- **`tauri.conf.json` `"targets": "all"`** stays as-is — the bundle set is
  controlled per-invocation at the CLI layer (`--bundles app`, platform-aware),
  keeping the committed conf generic across platforms.
- **Code-signing / notarization** — separate follow-up (unchanged).
- **Linux bundling** — untouched.

## Critical files

**Modified**
- `plugins/framework/plugins/cli/bin/commands/release.ts` — `wrapTauri` build
  branch: macOS `--bundles app` + new `packageMacDmg` helper.
- `.gitignore` — add `/tauri/src-tauri/appdmg.spec.json`.
- `tauri/README.md` — resolve the dmg caveat; update the build-step description.

**Read / reused (no change)**
- `run()` helper — `release.ts:65-80` (spawns `bun x …`, throws on non-zero).
- `productName` / `safeId` derivation — `release.ts:444-446`.
- `tauri/src-tauri/icons/icon.icns` — appdmg volume icon (built before bundling).

## Verification (end to end, on a macOS Rust host)

1. **Headless build succeeds.** From a non-interactive shell (no Aqua session),
   run `./equin release --composition sonata --target tauri`. It must run to
   completion with exit 0 — no `-1712`, no AppleEvent timeout.
2. **Both artifacts exist.**
   - `tauri/src-tauri/target/release/bundle/macos/Sonata.app`
   - `tauri/src-tauri/target/release/bundle/dmg/Sonata.dmg`
   and the final CLI log prints both paths.
3. **dmg is well-formed + styled.** `hdiutil attach Sonata.dmg` mounts a volume
   showing `Sonata.app` and an `Applications` symlink with the spec's layout;
   `hdiutil detach` cleanly. (No GUI needed to verify mount/contents.)
4. **`.app` still runs** (existing behavior, regression check): drive the embedded
   `launch`/`teardown` as the README's stack-verification does — bare
   `http://localhost:<port>/` serves the composition single-origin; teardown
   leaves no orphaned gateway/postgres/pgbouncer.
5. **Re-release is idempotent.** Run the release twice; the second run overwrites
   `Sonata.dmg` (no "file exists" error from appdmg) and succeeds.
6. **Linux unaffected** (if a Linux host is available): `--target tauri` build
   still emits the default deb/rpm/AppImage with no behavior change.
