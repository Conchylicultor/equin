# bundle

A detached daemon that outlives its backend must not run from the backend's
checkout: main's checkouts are per-commit slots
(`infra/git/main-slots`), and a slot no app serves and no lease holds is free —
checked out at another commit or deleted by reclaim, under whatever still runs
from it (Playwright loads its own modules lazily, a host spawns scripts by
path). `bundleDaemon` gives such a daemon a directory of its own to run from.

```ts
const bundle = await bundleDaemon({
  entry: "plugins/<p>/bin/host.ts",              // repo-relative
  external: PLAYWRIGHT_BUNDLE_EXTERNAL,          // { <package>: "<why it cannot be inlined>" }
  seal: [installed.ready],                       // dependency installs it reads as sealed
  dir: myBundlesDir.path,                        // this daemon's own bundle home (a data dir)
});
try {
  instance = myDaemon.launchDetached({
    argv: [process.execPath, bundle.entry, "--code-id", codeId],
    cwd: bundle.dir,
    holdFds: [bundle.inUse],                     // the daemon holds its bundle for life
    pidFile, env,
  });
} finally {
  bundle.inUse.close();
}
```

Used by the two browser hosts (`infra/mcp/browser`, `apps/browser/engine`).

## What a bundle is

`<dir>/<hash>.bundle/`:

- **One JS file per entry** (`Bun.build`, target bun, unminified), at the
  entry's repo-relative path with `.js`: every repo module and every npm
  package inlined, except the `external` ones.
- **The scripts it runs by path**, at their repo-relative paths: every
  `scriptPath("<repo-relative>")` literal (`infra/paths/repo-root`) in a
  loaded module, a TypeScript one bundled the same way (to a fixed point —
  `flock-wait.ts` names `flock-block.ts`), any other file copied.
- **`node_modules/`**: each external package, and its dependencies
  (`dependencies`, and `optionalDependencies` that are installed), resolved
  the way the runtime would from the checkout (the `node_modules` walk;
  bun's isolated store puts a package's dependencies beside it) and cloned
  (`cp -c`, APFS clones). One install per name; two needed is an error.
- **`deps.sealed.json` + `deps/<id>`**: each `seal` install linked
  (`infra/deps`' `linkSealedDep`), so the bundled code's `readyNow(dep)`
  answers it without resolving anything through a checkout.
- `bundle.json` (what it holds, who made it, the build time) and
  `in-use.lock`.

The bundle directory is the bundled code's `REPO_ROOT`: `repo-root` reads a
location inside a directory named `*.bundle` as that directory (its entry at
the root of the bundle's tree, a script below it), so `scriptPath` finds the
bundled scripts and the deps engine finds the seal. A read of any other repo
file there finds nothing — loudly, like a compiled binary's.

## Nothing from the checkout, by construction

The bundler refuses (throws) rather than emit a bundle that would reach back:

- **A module that reads its own location** — `import.meta.dir` / `.url` /
  `.dirname` / `.path` / …, `__dirname`, `__filename` — anywhere but
  `repo-root` (`REPO_ROOT_MODULE`). In a bundle every module's location is
  the bundle file's, so such a path points at a file the bundle lacks.
  Name the file with `scriptPath`, read it through `REPO_ROOT`, or keep the
  package external.
- **Any line naming the checkout's absolute path** (either spelling, real
  path included): Bun inlines a CommonJS module's `__dirname` as the
  directory it bundled it from — that is how an inlined Playwright would read
  `playwright-core` from the slot (`PLAYWRIGHT_BUNDLE_EXTERNAL`).
- **A `scriptPath` call whose argument is not a string literal**, or names no
  file.
- An external that does not resolve.

So "is this package bundleable?" is answered by evidence, per package: the
check names the module that is not. Playwright is external
(`PLAYWRIGHT_BUNDLE_EXTERNAL`, in `deps/playwright-browser`, beside the
imports it is about). Nothing native reaches the browser hosts (esbuild,
vite, rolldown and the lexers came only through `web-artifacts`' build
pipeline, cut at `web-artifacts/served-paths`).

## Content-addressed, held, reclaimed

- **Hash** = the emitted files' bytes, the copied scripts' paths, each
  external's name and bun store key (version + patch), each seal's id,
  identity and payload path. Not the checkout's path: slots at different
  commits with the same host closure share one bundle.
- **Made once**: built in memory, written to `.staging-<pid>-<rand>/`,
  renamed to `<hash>.bundle`; an existing one is reused, and a concurrent
  maker whose rename loses keeps the winner's (same content). The build runs
  on every call — it is how the hash is known.
- **Held**: `inUse` is a shared flock on `in-use.lock`, taken before the call
  returns (and only once the manifest is still there, so a bundle being
  reclaimed is never returned). `launchDetached({ holdFds: [inUse] })` hands
  the descriptor to the daemon as fd 3: the lock passes from launcher to
  daemon with no unheld moment and is dropped by the kernel when the daemon
  dies, however it dies. Nothing in the daemon's code takes it.
- **Reclaimed by the next call, in that `dir` only**: every other
  `*.bundle` whose lock an exclusive try gets (nobody holds it) is renamed to
  `.trash-<pid>-<rand>` and deleted; staging and trash dirs of dead pids go
  too. So each daemon's home keeps the bundles running daemons hold plus the
  current one. Each daemon owns its own `dir` — the main-slots reclaim knows
  nothing of bundles, and two daemons never share a home (each would reclaim
  the other's).

## Cost

Measured 2026-11-17 on the M-series dev machine, under `./equin run` —
which runs at darwinbg (background) priority, so these wall times are NOT
foreground costs (a background read measured ~3× slower):

| | agent-browser host | browser-engine host |
|---|---|---|
| `Bun.build` (2 rounds: entry, then scripts) | 150–270 ms | 150–250 ms |
| whole call, bundle made (write + 2 package clones + seal) | 350–420 ms | 260–320 ms |
| bundle size | ~0.5 MB JS + 18 MB `playwright`/`playwright-core` clones (APFS: no new blocks) | same |

Live, from a worktree backend (foreground once ready) launching the engine
host: `buildMs` 331 in its `bundle.json`; the host was `ready` within the
same second. A backend pays it once per host launch (a host exits after 5 / 30 idle
minutes), on its event loop for the onLoad scan only — the build itself runs
on Bun's bundler threads. `bundle.json`'s `buildMs` records each bundle's own.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: bundleDaemon: a detached daemon's entry as a self-contained, content-addressed directory (<dir>/<hash>.bundle) — one Bun.build JS file per entry with repo code and pure-JS packages inlined, the scripts it runs by path (scriptPath literals) bundled beside it, the external packages cloned into its node_modules and the sealed dependency installs linked — held by a shared in-use flock the daemon inherits (launchDetached holdFds), so a process run from it reads nothing from the checkout it was made from; every call reclaims the bundles nothing holds.
- Cross-plugin:
  - Imported by:
    - `apps/browser/engine`
    - `infra/mcp/browser`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/bundle.ts` (debt)
- Server:
  - Exports (types):
    - `DaemonBundle`
    - `DaemonBundleSpec`
  - Exports (values): `bundleDaemon`

<!-- AUTOGENERATED:END -->
