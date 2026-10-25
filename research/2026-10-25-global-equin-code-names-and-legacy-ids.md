# Step 5: code-only names → equin, kept ids owned in one place, main namespace shown as "equin"

Track: rename-to-equin (wiki `block-dc049371-1f5f-413d-af7b-6e12b531d579`). Implements Step 5 of `research/2026-10-25-global-equin-internal-identifiers.md`.

## Context

After step 4, about 830 source lines still spell `singularity` in some case. This excludes `~/.singularity` (step 7), `SINGULARITY_*` (step 6), commit trailers, GitHub URLs and committed SQL. They are three different things:

1. **Code-only names.** Nothing stores them, and every build regenerates them: the `@singularity/plugin-*` scope, the `"singularity"` package.json key, camelCase identifiers, temp prefixes, the Go module and the Python packages. These are renamed.
2. **Kept ids.** These are stored state, or wire that crosses versions. Each is spelled as a literal at its own use site (e.g. `gateway/worktree.go:799`, `menu-bar/rust/src/cli.rs:12`, `pgbouncer/scripts/start.ts:22`, and both ends of the OAuth `postMessage`). Nothing owns them, and nothing stops a new `singularity` from appearing. They get one owner and a check.
3. **The main namespace leaking to people and agents.** The logs picker has `const MAIN = "singularity"`, the worktree-identity row renders `place.namespace`, and `query_db` documents `database: "singularity"`. These should display and accept the public label "equin".

The outcome: after this step, the only `singularity` left in tracked source is the owner leaf, the step 6/7 forms, GitHub URLs, and stored history (migrations).

## Design

### A. The owner: `LEGACY_IDS` in `framework/product-name/core`

A new `core/internal/legacy-ids.ts` sits beside `product-name.ts`. It stays a leaf with no imports. Each entry has a name, a value, why it is kept, and an optional `mirrors` field listing the non-TypeScript files that must spell it.

```ts
export const LEGACY_IDS = {
  mainNamespace:        { value: "singularity", kept: "namespace/DB/sockets/logs dirs, stored everywhere", mirrors: ["gateway/proxy.go", "gateway/worktree.go", "plugins/menu-bar/rust/src/cli.rs"] },
  pgUser:               { value: "singularity", kept: "cluster role", mirrors: ["plugins/database/plugins/pgbouncer/scripts/start.ts"] },
  pgBaseDatabase:       { value: "singularity", ... },
  keychainService:      { value: "singularity", kept: "holds the secrets master key" },
  codesignIdentifier:   { value: "dev.singularity.gateway", kept: "TCC grants keyed on it" },
  launchdLabel:         { value: "dev.singularity.gateway", kept: "until step 7", mirrors: ["plugins/menu-bar/rust/src/gateway.rs", "sidequests/clean-install/steps-install.sh"] },
  conversationTrailer:  { value: "Singularity-Conversation", ... }, pushTrailer: { value: "Singularity-Push", ... },
  gitConfigPrefix:      { value: "singularity", kept: "singularity.publish.{remote,url}, singularity.autoIdentityEmail in every checkout's .git/config" },
  autoIdentityDomain:   { value: "singularity.invalid", ... },
  gitLockDir:           { value: "singularity-locks", ... },
  mergeMarkersDir:      { value: "singularity-merge-markers", mirrors: [".githooks/post-rewrite", "…/cli/scripts/regen-*.sh"] },
  writeProbeRef:        { value: "refs/heads/singularity-write-probe", ... },
  worktreeLockReason:   { value: "singularity agent worktree", kept: "written into every worktree's .git lock file" },
  spareLockReason:      { value: "singularity-spare", ... },
  dbObjectPrefix:       { value: "singularity", kept: "__singularity_migrations, __singularity_derived_view_state, singularity_mark_superseded(), GUC singularity.superseded" },
  migrationMarker:      { value: "singularity", kept: "`-- singularity:{snapshot,phase,…}` in every committed .sql" },
  requestHeaderPrefix:  { value: "x-singularity-", kept: "stale tabs keep sending it across a deploy" },
  mimePrefix:           { value: "application/x-singularity-", kept: "drag between tabs on different versions" },
  browserKeyPrefix:     { value: "singularity", kept: "localStorage drafts, shared-ws/worker names, IndexedDB, legacy tabId/appInstances keys" },
  authPopup:            { value: "singularity-auth" }, authCompleteMessage: { value: "singularity.auth.complete" },
  agentBrowserName:     { value: "singularity-agent-browser" },
  artifactGlobalPrefix: { value: "__SINGULARITY_", kept: "content-addressed artifacts from older builds read __SINGULARITY_GRAPH__/__COMMIT__" },
  backupPlatformSource: { value: "singularity-platform", kept: "backup run rows and archives" },
  fileExplorerPlace:    { value: "singularity" }, deployKeyComment: { value: "singularity-deploy-", kept: "in remote authorized_keys" },
  cliShim:              { value: "singularity", kept: "the legacy CLI shim (cli-name's CLI_NAMES)" },
  githubRepo:           { value: "Conchylicultor/singularity", kept: "user decision" },
} as const satisfies Record<string, LegacyId>;
```

The final list is whatever the sweep in C turns up. The rule for sorting an entry: if it is stored, or read by a process on another version, it is kept and goes here. If it is produced and consumed by the same build, it is renamed. Existing TypeScript owners keep their names but derive from it: `MAIN_COMPOSITION_ID = LEGACY_IDS.mainNamespace.value`, `PG_USER`, `KEYCHAIN_SERVICE`, `CACHE_*_KEY`, `MIGRATIONS_TABLE_NAME`, `ORIGIN_HEADER`, … Use sites that spell a literal today (both ends of `auth.complete`, `fork.ts:84`, `live-fork-databases.ts:15`, `worktree-workspace.ts:38`, the e2e scripts) import the owner instead.

### B. The check: `product-name:legacy-id` (plus mirrors in sync)

This goes in `product-name/check`, as a second check beside `product-name:legacy`. It reuses `listCandidateSources`.

- **It bans** `singularity`, case-insensitively, in every tracked file. That covers camelCase names, the package scope, and the package.json key.
- **These are still allowed:**
  - `SINGULARITY_` (step 6).
  - A `.singularity` path segment (step 7). The hint says both of these go away when their step lands.
  - `github(usercontent).com/<owner>/singularity` URLs.
- **These are out of scope:**
  - `research/`.
  - Derived artifacts, which are regenerated from sources the check already covers: `bun.lock`, `*.generated.ts`, `config/**/*.origin.jsonc`, `docs/plugins-*.md`.
  - The owner leaf and the check itself (exempted by product-name itself).
- **Mirror files:** a file listed in some entry's `mirrors` may contain a line with `singularity` only if that line holds one of its declared values verbatim.
- **The in-sync half:** every declared mirror must still contain its value. This is the same substring technique as `namespace:grammar-in-sync`, generalised.
- **Go refactor:** `gateway/worktree.go:799` gets a named `const mainNamespace = "singularity"`, so its mirror line is unambiguous.
- **Committed migration SQL** (`database/migrations/data/**`, `meta/schema.snapshot.json`) is immutable history. It is exempted via `database/migrations/exempt/index.ts`, `kind: "sanctioned"`.

### C. The renames (mechanical)

| What | Change |
|---|---|
| Package scope | `plugin-id.ts`: `PACKAGE_SCOPE = \`@${PRODUCT_NAME}\``, so `packageNameFor` → `@equin/plugin-*`. R7 in `plugin-boundaries/check/index.ts:647` and `no-plugin-imports-in-core` read the constant instead of the literal. Root `package.json` `"name"` → `equin`. `./equin build` rewrites the 1,529 package.json files; `bun install` rewrites `bun.lock`. Fix the test fixtures (`package-names.test.ts`, `read-set.test.ts`, `lint-cache.test.ts`, `relocate/plan.test.ts`). |
| package.json key | `PLUGIN_MANIFEST_KEY = PRODUCT_NAME` in plugin-id core. Readers: `plugin-tree.ts:263`, `structure/facet:59`, `plugin-boundaries` (compositionRoot), `codegen/package-names.ts`, `guards/package-json-hint.ts`. Rewrite the 132 files `"singularity": {` → `"equin": {`. `no-disabled-flag` reads `equin.disabled`; a leftover `singularity` key is now caught by B. |
| camelCase / locals | `isSingularity*`, `projectIsSingularity`, `isSingularityProjectDir` → `isRepoProjectDir`, `useSingularityPlace` → `useRepoPlace`, `singularityKey`, `emptySingularityDir`, `assembleSingularityPlatform` → `assemblePlatform`, guard `RepoKind` `"singularity"` → `"equin"`, `__singularityWsTestHook` / `__singularityProxyScheduleRefresh` (same-build globals). |
| Config keys | `stats/cost` `singularityOnly` → `repoOnly`, `COST_SCOPES` `"singularity"` → `"repo"`. Only origin copies exist in the user layer, and a stale override fails config validation loudly. |
| Backup plugin dir | `./equin plugin move backup/sources/singularity-platform backup/sources/platform`. The source id stays `LEGACY_IDS.backupPlatformSource` (rows and archives). |
| Temp prefixes and stamps | `singularity-screenshots`, `-summary-`, `-backup-`, `-clone-journey-`, `-cfg-`/`-bad-`/`-empty-` in tests, `node_modules/.singularity-deps` → `${PRODUCT_NAME}-…` (a stamp rename costs one reinstall). The `singularity:` message prefixes in `bootstrap/ensure-deps.ts` and `locked-bun.ts` → `PRODUCT_NAME`. |
| Go module | `gateway/go.mod` `singularity/gateway` → `equin/gateway`, plus its internal imports. |
| Python | `audio-analysis/python/singularity_audio` → `equin_audio` (pyproject name `equin-audio`, `uv.lock`, the module strings in `ensure.ts:167` and `sonify.ts:30`). `sonata/transcription/python/singularity_transcribe` → `equin_transcribe` (`bin/st`). Verify the venv rebuilds on the lock change. |
| Test fixtures | Namespace literals → `MAIN_WORKTREE_NAME` / `LEGACY_IDS`. Checkout-path fixtures (`/Users/x/dev/singularity`, `-Users-…-singularity`) → a neutral repo name. |
| Prose | Comments, CLAUDE.md files and tool descriptions name the concept ("the main namespace") or the owner (`LEGACY_IDS.mainNamespace`), never the string. |

### D. Namespace display and input (`infra/namespace/core`)

- `namespaceLabel(ns)` = `NAMESPACE_HOST_LABELS[ns] ?? ns`. `namespaceHost` uses it, so it is the one display spelling.
- `resolveNamespace(input)` = `NAMESPACE_HOST_ALIASES[input] ?? input`. `namespaceFromHost` uses it. Every typed-namespace entry calls it:
  - The `query_db` `database` parameter. Its description becomes `"equin"` for main.
  - The `worktree` parameters of boot-bench, runtime profiling and queue-health.
  - `./equin db fork [target]`.
  - `fork-bench --source`.
- Display sites use `namespaceLabel`:
  - The logs `worktree-picker.tsx`: options keep the namespace as their value and show the label. `MAIN` becomes `MAIN_WORKTREE_NAME`.
  - The worktree-identity row (`identity.ts:86,88,104`) and its copy button, since inputs now accept the label.
  - Any CLI or deploy output that prints a namespace (grep at implementation time).
- Docs: root CLAUDE.md (`query_db` … `"equin"` for main; the Ports note), `database/query` CLAUDE.md, and the MCP tool descriptions.

## Out of scope

- `SINGULARITY_*` env vars (step 6).
- `~/.singularity`, `~/.backups/singularity`, the launchd label value and the install.sh default clone dir (step 7).
- The lint docs URL `github.com/anthropics/singularity/lint/<rule>`, spelled out 152 times and pointing at a repo that does not exist. B allows it as a GitHub URL; file it as a sidequest.

## Execution order

1. A: the owner, then route the existing owners and literal use sites through it.
2. D: the namespace helpers and their display and input sites.
3. C: the renames. The package scope and key go first, then build, so `bun.lock` regenerates. Then the code names, Go and Python.
4. B: the check. Run it, then sweep the residue (tests and prose) until it is green. Parallel Sonnet subagents can split the residue sweep by plugin subtree.
5. `./equin build`, verify, update the track page, and file step 6.

## Verification

- `./equin check`: `product-name:legacy-id`, `product-name:legacy`, `plugins-registry-in-sync`, `plugin-boundaries`, `type-check` and `namespace:grammar-in-sync` are all green.
- `./equin test plugins/framework/plugins/plugin-id plugins/framework/plugins/tooling/plugins/codegen plugins/plugin-meta/plugins/plugin-tree plugins/infra/plugins/namespace plugins/framework/plugins/product-name plugins/stats/plugins/cost`.
- Gateway: `go build ./... && go test ./...` in `gateway/`. Menu bar: `cargo check`.
- A negative test of the check: add `isSingularityFoo` to a scratch file and confirm the check fails, then remove it.
- `query_db` with `database: "equin"` returns main's rows, and `"singularity"` still works.
- `screenshot.ts --path /debug/logs` shows "equin (main)" in the picker, and the worktree-identity row in the health popover is right.
- Audio analysis or transcription still run, which shows the venv picked up the new module name.
