# Bundled Postgres client tools (`pg_dump` / `pg_restore`)

## Context

Two things copy a database by spawning Postgres's own client programs, looked up by bare name on the PATH:

- forking a worktree's database: `plugins/database/plugins/admin/server/internal/fork.ts` runs `pg_dump` then `pg_restore`
- nightly database backups: `plugins/database/plugins/admin/server/internal/backup.ts` runs `pg_dump`

Nothing in the repo provides those programs. The embedded Postgres package (`@embedded-postgres/<platform>`, built from Zonky's artifacts) ships only `initdb`, `pg_ctl` and `postgres`. We checked Zonky's upstream artifacts on 2026-09-20 and they hold the same three, so we can't take the client tools from there either.

So today:

1. **Homebrew is a prerequisite only because of this.** `docs/setup.md` lists Bun, Go and `postgresql@18` via `brew`. mise already covers Bun and Go, and installing those two through brew is what bypasses `mise.lock`. The Postgres client is the only row mise can't cover.
2. **The client and server versions drift apart.** A test run had Homebrew's 18.6 client talking to the embedded 18.3 server. Nothing ties the two together.
3. **A released bundle can't fork or back up at all.** It vendors `postgres` and `pgbouncer` but no client tools. On a server box with no Postgres install, `pg_dump` isn't there.

The goal: `bun install` provides a `pg_dump` / `pg_restore` built from the same Postgres release as the embedded server. The fork and backup code use that copy and never the PATH. A release bundle vendors it. Homebrew disappears from the setup doc.

## Approach

We follow the PgBouncer precedent (`research/2026-05-14-global-pgbouncer-embedded-packages.md`): a small external repo builds the binaries in CI for four platforms and publishes them as per-platform npm packages. A database sub-plugin then installs them as `optionalDependencies`.

### 1. External repo `equinai/pg-client-embedded` → `@equin/pg-client-<platform>`

A new repo with the same layout as `pgbouncer-embedded`: `scripts/build.sh`, `packages/{darwin-arm64,darwin-x64,linux-arm64,linux-x64}/package.json`, and `.github/workflows/build-and-publish.yml` (a matrix build, then one publish job, triggered by a `v*` tag). The CI matrix and runners are copied from the PgBouncer workflow.

**Package shape.** Each package has `os`/`cpu` fields, sets `files: ["native/bin/pg_dump", "native/bin/pg_restore"]`, and has **no postinstall**. Plain executables need no hydration, which also avoids the `trustedDependencies` problem the embedded package has.

**Version.** The package version is the Postgres version, `18.3.0`. It must match the `18.3` inside the embedded package's `18.3.0-beta.17`.

**Build (`build.sh`).** Download the `postgresql-18.3` source tarball and verify its checksum. Then:

- **Configure:** `./configure --without-icu --without-readline --without-openssl --without-gssapi --with-zlib`, plus lz4 and zstd off. These tools only ever reach a local cluster over a Unix socket, or over localhost TCP in the bring-your-own-Postgres mode, so they need no SSL, GSSAPI or ICU. **zlib stays in.** `-Fc` archives are compressed with it, and a client built without zlib can't read a compressed archive, so without it old backups couldn't be restored.
- **Build only what's needed:** `make -C src/interfaces/libpq`, `src/common`, `src/port`, `src/fe_utils`, `src/bin/pg_dump`. `src/bin/pg_dump` is where both `pg_dump` and `pg_restore` are built.
- **Link libpq and zlib statically, and libc dynamically.** Delete the shared libpq before the link (or pass the `.a` explicitly) so nothing depends on a `libpq.so`/`.dylib`. We keep libc dynamic on Linux on purpose. A fully static glibc breaks libpq's `getpwuid_r` default-user lookup through NSS. PgBouncer's "fallback" link mode is exactly this. Build Linux on `ubuntu-22.04` so the glibc baseline stays low.
- **macOS:** `strip`, then `codesign -s - --force` (after stripping, an arm64 binary needs an ad-hoc signature again).
- **Verify in CI:** both tools must print `pg_dump (PostgreSQL) 18.3`. `otool -L` / `ldd` must show no libpq, ssl or icu. Then run a smoke test: `initdb` a scratch cluster using the matching `@embedded-postgres` package, then dump, restore, and compare row counts. This proves client and server work together before anything is published.

**Needs the user:** create the GitHub repo, add the `NPM_TOKEN` secret, push the tag. I can write every file, but I can't publish.

### 2. New sub-plugin `plugins/database/plugins/client-tools/`

This is the one place that answers "where is `pg_dump`?". It's a sibling of `embedded` and `pgbouncer`, each owning one native dependency.

- `package.json`: `optionalDependencies` on the four `@equin/pg-client-<platform>` packages at `18.3.0`.
- `server/index.ts` barrel → `server/internal/bin.ts`:
  ```ts
  type PgClientTool = "pg_dump" | "pg_restore";   // closed: a typo is a tsc error
  export function pgClientBin(tool: PgClientTool): string
  ```
  Resolution order:
  1. `SINGULARITY_PG_CLIENT_BIN_DIR`, which the release launcher sets. If it's set but the file is missing, throw.
  2. `<plugin>/node_modules/@equin/pg-client-<platform>/native/bin/<tool>`. The platform mapping is the one `embedded/scripts/start.ts` already has.
  3. If neither exists, throw `PgClientToolMissingError`, naming the path and saying "run `bun install`". There is **no PATH fallback.** A fallback would bring back the silent Homebrew dependency and the version drift.

  The result is memoized per tool.
- `CLAUDE.md` in the plugin explains why: version matched by construction, no PATH.

### 3. Call sites

- `fork.ts`: `"pg_dump"` → `pgClientBin("pg_dump")`, and the same for `"pg_restore"`.
- `backup.ts`: `"pg_dump"` → `pgClientBin("pg_dump")`.

The admin plugin imports `@plugins/database/plugins/client-tools/server`. The CLI's `db fork` (`plugins/framework/plugins/cli/plugins/db/cli/fork.ts`) goes through the same `forkDatabase`, so it's covered.

### 4. Guardrails (so the PATH lookup can't come back)

- **Check `database-client-tools:version-matches-server`** in `client-tools/check/`. It reads the pinned `@equin/pg-client-*` version and the `@embedded-postgres/*` version from the two `package.json` files, and fails unless their Postgres major.minor agree (`18.3` ↔ `18.3.0-beta.17`). A bump of one without the other then fails `push`. It also asserts that all four platform pins inside each file are equal.
- **Lint rule `client-tools/no-path-pg-client`** in `client-tools/lint/`. It flags the string literal `pg_dump`, `pg_restore` or `pg_dumpall` as the first element of an argv array literal, which is the shape every `spawnCaptured` / `spawnPassthrough` call takes. The message points to `pgClientBin`. This is the strongest rung available: a string can't be made a type error.
- `sidequests/claude-web/session-picker.sh` is a shell script outside the plugin tree. We leave it alone.

### 5. Release bundles

`plugins/framework/plugins/cli/plugins/release/cli/run.ts`:

- Add `@equin/pg-client-${tag}` to `stageForeignNatives`' deps (version via `installedVersion(clientToolsDir, …)`, the same way pgbouncer does it).
- Add a `pgClientNativeDir(root, tag, src)` resolver. It probes `bin/pg_dump` and `bin/pg_restore`, not just the directory (same reason as the existing probes). Call it in `assertStagedNativesComplete`.
- Copy it to `<out>/pg-client/bin/`, and add a line to the bundle-layout comment.

`plugins/infra/plugins/launcher/bin/launch.ts`: `process.env.SINGULARITY_PG_CLIENT_BIN_DIR ??= join(bundleRoot, "pg-client", "bin")`.
`plugins/infra/plugins/launcher/core/internal/runtime-env.ts`: add the variable to `RUNTIME_FORWARDED_ENV` with its reason. The `launcher:runtime-env-declared` check enforces this.

### 6. Docs

- `docs/setup.md`: the Prerequisites table becomes mise (`mise install`, which provides Bun, Go, tmux, Rust from `mise.lock`). Remove the Homebrew rows and the "client tools not bundled yet" paragraph. Replace it with one sentence: the client tools come with `bun install` and always match the server version. The "Using system PG instead of embedded" section keeps its `brew install postgresql@18` line, because that's how you run your own server, which that section is about. Reword it slightly so it reads as that section's own concern and not a global prerequisite.
- `plugins/database/plugins/embedded/CLAUDE.md` line 18: remove "PATH-resolved … until we bundle our own", and point to `client-tools`.
- `plugins/database/plugins/admin/CLAUDE.md`: note that `pg_dump` / `pg_restore` are resolved through `pgClientBin`.
- `./equin build` regenerates `docs/plugins-*.md`.

## Order of work

1. Write the `pg-client-embedded` repo files. Run `build.sh` locally on darwin-arm64 and check the binary (version, `otool -L`, a dump/restore against the local cluster).
2. User: create the repo, add the secret, tag `v18.3.0`, and confirm all four packages are on npm.
3. In this worktree: steps 2–6 above, then `./equin build`.

Step 3 can't install until step 2 has published. Until then, the Singularity side can be developed against a local `file:` path to the built package, but it can't be pushed.

## Verification

- `./equin build` passes, including the new check and lint rule. Change one pin temporarily to `18.4.0` and confirm the check fails.
- `./equin test plugins/database/plugins/client-tools`: a unit test for `pgClientBin`. The env override wins. A missing file throws `PgClientToolMissingError`. An unknown platform throws.
- Remove Homebrew from the PATH (`PATH=/usr/bin:/bin` for the backend, or `brew unlink postgresql@18`), then:
  - `./equin db fork` into a scratch name succeeds;
  - a backup run from the Backup app succeeds, and the resulting `.dump` restores with the bundled `pg_restore`.
- Check `pg_dump --version` from the resolved path: it prints 18.3, the same as `SELECT version()` on the cluster.
- Release: `./equin release --dev` for the host platform. Confirm `<out>/pg-client/bin/pg_dump` exists, then launch it and trigger a backup inside the bundle.

## Risks

- **Postgres's makefiles prefer the shared libpq.** If deleting the `.so`/`.dylib` isn't enough, link with `LIBS` / an explicit `libpq.a` path. Last resort: build with meson and `-Ddefault_library=static`.
- **`macos-13` Intel runners may be gone.** Same fallback as PgBouncer: cross-compile with `-arch x86_64` on the arm runner.
- **Bring-your-own-Postgres users on a newer server major (19+).** A `pg_dump` 18 refuses to dump a newer server. That's acceptable: the setup doc already says Postgres 18, and the error is loud.
