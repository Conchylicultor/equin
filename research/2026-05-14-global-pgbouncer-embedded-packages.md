# PgBouncer Embedded npm Packages

## Context

equin embeds PostgreSQL via `@embedded-postgres/*` npm packages (per-platform optionalDependencies). With 10+ worktrees active, each holding ~13 PG connections, the `max_connections=500` ceiling creates congestion. PgBouncer (connection pooler) is the fix, but it needs to be embedded the same way PG is — no system dependency, just `bun install`.

The repo `equinai/pgbouncer-embedded` is created. This plan covers: populating it with a CI matrix that builds PgBouncer statically for 4 platforms and publishes `@equin/pgbouncer-{platform}` to npm.

## Version Pins

- **PgBouncer**: `1.25.2` (latest stable, 2026-05-08)
- **libevent**: `2.1.12-stable` (latest stable, 2023-07-05)
- **npm package version**: `1.25.2` — match PgBouncer version directly

## Repo Structure

```
pgbouncer-embedded/
├── .github/workflows/
│   └── build-and-publish.yml     # Matrix build + npm publish
├── .gitignore
├── .npmrc                        # NPM_TOKEN template for local publish
├── scripts/
│   └── build.sh                  # Compile libevent + pgbouncer for host platform
├── packages/
│   ├── darwin-arm64/package.json  # @equin/pgbouncer-darwin-arm64
│   ├── darwin-x64/package.json    # @equin/pgbouncer-darwin-x64
│   ├── linux-arm64/package.json   # @equin/pgbouncer-linux-arm64
│   └── linux-x64/package.json     # @equin/pgbouncer-linux-x64
└── README.md
```

After build, each package gains `native/bin/pgbouncer` (gitignored, CI-generated).

## Package Shape

Each `@equin/pgbouncer-{platform}` package mirrors the `@embedded-postgres` pattern:

```json
{
  "name": "@equin/pgbouncer-darwin-arm64",
  "version": "1.25.2",
  "description": "Statically-linked PgBouncer binary for macOS ARM64",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "files": ["native/bin/pgbouncer"],
  "license": "ISC",
  "publishConfig": { "access": "public" }
}
```

The `os` and `cpu` fields are what bun/npm use to install only the matching platform package. Consumers resolve the binary at:
```
node_modules/@equin/pgbouncer-<platform>/native/bin/pgbouncer
```

## Build Script (`scripts/build.sh`)

Auto-detects platform. Does two things:

### 1. Build libevent statically
```bash
curl -fsSL "$LIBEVENT_URL" | tar xz -C "$BUILD_DIR/src"
cd libevent-2.1.12-stable
./configure \
  --prefix="$LIBEVENT_PREFIX" \
  --enable-static --disable-shared \
  --disable-openssl --disable-samples --disable-benchmark
make -j$(nproc || sysctl -n hw.logicalcpu)
make install
```

### 2. Build PgBouncer against static libevent
```bash
curl -fsSL "$PGBOUNCER_URL" | tar xz -C "$BUILD_DIR/src"
cd pgbouncer-1.25.2

# Override pkg-config — PKG_CHECK_MODULES respects these env vars
export LIBEVENT_CFLAGS="-I${LIBEVENT_PREFIX}/include"

# Platform-specific linking:
#   Linux:  LIBEVENT_LIBS="<path>/libevent.a -lpthread -ldl" + LDFLAGS="-static"
#   macOS:  LIBEVENT_LIBS="<path>/libevent.a" (system dylibs always dynamic on macOS)

./configure --without-openssl --disable-evdns
make -j$(nproc || sysctl -n hw.logicalcpu)
strip pgbouncer
cp pgbouncer packages/<platform>/native/bin/pgbouncer
```

Key decisions:
- **`--without-openssl`**: PgBouncer connects to PG over Unix sockets, no TLS needed
- **`--disable-evdns`**: skip libevent DNS resolver (pgbouncer uses getaddrinfo)
- **`LIBEVENT_CFLAGS`/`LIBEVENT_LIBS`**: bypass pkg-config, point directly at static build
- **Linux `-static`**: fully static ELF, no glibc runtime dependency
- **macOS**: libevent statically linked, only system `libSystem` is dynamic (Apple restriction)

## CI Workflow (`.github/workflows/build-and-publish.yml`)

**Trigger**: git tag push `v*` (e.g. `v1.25.2`) + manual `workflow_dispatch`

### Build job (4 parallel)

| Platform | Runner |
|---|---|
| `darwin-arm64` | `macos-latest` (ARM, macos-14+) |
| `darwin-x64` | `macos-13` (Intel) |
| `linux-x64` | `ubuntu-latest` |
| `linux-arm64` | `ubuntu-24.04-arm` |

Each runner:
1. Checkout
2. Install build deps (`build-essential pkg-config` on Linux; Xcode CLI pre-installed on macOS)
3. Run `bash scripts/build.sh`
4. Verify: `file` + `pgbouncer --version`
5. Upload binary as artifact

### Publish job (after all 4 build jobs succeed)

1. Download all 4 artifacts
2. Stage each binary into `packages/<platform>/native/bin/pgbouncer`
3. Set version from tag (strip leading `v`)
4. `npm publish --access public` for each package

```yaml
env:
  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Uses `actions/setup-node` with `registry-url: 'https://registry.npmjs.org'` — the standard approach, no `.npmrc` needed in CI.

## Implementation Steps

### 1. Clone and populate the repo

```bash
git clone git@github.com:equinai/pgbouncer-embedded.git /tmp/pgbouncer-embedded
cd /tmp/pgbouncer-embedded
```

Create all files listed in the repo structure above.

### 2. Test the build locally (macOS arm64)

```bash
bash scripts/build.sh
packages/darwin-arm64/native/bin/pgbouncer --version
```

Should print `PgBouncer 1.25.2 ...`

### 3. Configure GitHub repo secrets

Add `NPM_TOKEN` secret in `equinai/pgbouncer-embedded` → Settings → Secrets → Actions.

### 4. Push and tag

```bash
git add -A && git commit -m "Initial: build + publish pipeline for 4 platforms"
git push origin main
git tag v1.25.2 && git push origin v1.25.2
```

### 5. Verify CI

- All 4 build jobs pass
- Publish job publishes 4 packages to npm
- `npm info @equin/pgbouncer-darwin-arm64` shows the package

### 6. Test consumption in equin (separate task, not this plan)

Add to `plugins/database/plugins/embedded/package.json`:
```json
"optionalDependencies": {
  "@equin/pgbouncer-darwin-arm64": "1.25.2",
  ...
}
```

Run `bun install`, verify `node_modules/@equin/pgbouncer-darwin-arm64/native/bin/pgbouncer` exists.

## Risks

- **Linux fully-static linking**: if `ubuntu-latest` is missing static glibc stubs, fallback to `-Wl,-Bstatic -levent -lpthread -Wl,-Bdynamic` (statically link only libevent+pthread, keep glibc dynamic). The binary still has no external deps beyond glibc 2.17+.
- **PgBouncer configure quirks**: if `LIBEVENT_CFLAGS`/`LIBEVENT_LIBS` env override doesn't work with 1.25.2's configure, fallback to `--with-libevent=$LIBEVENT_PREFIX` (the older flag, still supported).
- **macOS runner availability**: `macos-13` (Intel) may be deprecated by GitHub. Fallback: build x64 on ARM runner with `arch -x86_64` + Rosetta.

## Follow-up (separate task)

Wire PgBouncer into equin as `plugins/database/plugins/pgbouncer/` — lifecycle, config generation, connection routing. Covered by existing research doc `research/2026-05-02-global-embedded-postgres-pgbouncer.md`.
