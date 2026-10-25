# Internal "singularity" identifiers: which ones move, and how

Track: the rename-to-equin track (wiki `block-dc049371-1f5f-413d-af7b-6e12b531d579`), step 5 — the decision.

## Context

Steps 1–4 moved everything a person or agent *reads* onto "equin": the CLI, the address, and the product name. What remains are internal identifiers. ~3,200 tracked files still contain `singularity`. Some of these identifiers are stored state or contracts that span processes or versions: a gateway built from an older main runs backends from newer worktrees for days. Others still leak to people or agents (the main namespace in the logs picker, `query_db database: "singularity"`, `dev.singularity.gateway` in Login Items, `~/.singularity/` in every doc). This doc decides, for each family, whether it is **renamed now**, **renamed with migration**, or **kept for good**. A kept name gets ONE owner, so it is never spelled anywhere else.

Decided with the user (2026-10-25): env vars are renamed with a dual-read window; the code-only names go in one mechanical sweep; the GitHub repo keeps its name; the commit trailers are kept.

## Inventory and decision

| Family | Size | Nature | Decision |
|---|---|---|---|
| `@singularity/plugin-*` package scope | 1,529 package.json + bun.lock; derived in `plugins/framework/plugins/plugin-id/core/plugin-id.ts` | code only | **Rename** → `@equin/plugin-*` (change the derivation, regenerate) |
| `"singularity": {collapsed, compositionRoot}` package.json key | 132 files; read in `plugin-meta/plugin-tree/core/internal/plugin-tree.ts`, `facets/plugins/structure/facet` | code only | **Rename** → `"equin"` |
| camelCase / file names (`isSingularity`, `singularity.generated.ts`, tmp prefixes `singularity-screenshots`, `singularity-clone-journey-`) | ~60 | code only | **Rename** |
| `SINGULARITY_*` env vars | ~60 names, 1,378 mentions; in the installed plist's `-child-env` | cross-version contract | **Rename with a dual-read window** → `EQUIN_*` |
| `~/.singularity/` data dir | 2 roots (`paths/core/internal/paths.ts` `resolveDataRoot`, `gateway/main.go` `dataRoot`), plus Rust (`menu-bar/rust`), `install.sh`, sidequest scripts; absolute paths stored inside (database.json, pgbouncer.ini, plist, registry) | on-disk state | **Rename with migration**: new installs get `~/.equin`; existing installs migrate with a user-run command (user's note on the track page) |
| launchd/systemd label `dev.singularity.gateway` | `launcher/server/internal/gateway-service.ts` | installed state, visible in Login Items | **Rename with migration**, together with the data dir (the installer removes the old job) |
| Main namespace `singularity`, its DB, PG user/base DB (`database/embedded/shared/internal/paths.ts`), `MAIN_COMPOSITION_ID` | sockets, registry, logs dirs, DB rows, gateway `worktree.go:799` | stored state across every subsystem | **Keep**. Fix the leaks instead: a namespace's *display* is its public label (`NAMESPACE_HOST_LABELS`), and everywhere a namespace is typed (`query_db database`, CLI flags) also accepts the label, through the existing alias table |
| Commit trailers `Singularity-Conversation:` / `Singularity-Push:` | every commit in history; ~8 readers | immutable history | **Keep** (user) |
| Git config keys `singularity.publish.{remote,url}` (`git/remotes/core/internal/cache.ts`), git-dir lock dirs `singularity-locks`, `singularity-merge-markers` | shared by every worktree's checkout, on mixed versions | cross-version contract | **Keep**. Renaming a lock dir splits the lock between versions, which is a correctness bug |
| Keychain service `singularity` (`secrets/central/internal/key-store.ts`) | holds the secrets master key | stored, and losing it is catastrophic | **Keep** |
| Codesign identifier `dev.singularity.gateway` (`launcher/deps/internal/gateway.ts`), existing code-signing cert names | TCC grants are keyed on them | stored OS grants | **Keep**. Renaming re-prompts every permission |
| Stable ids: backup source `singularity-platform`, file-explorer place `singularity`, IndexedDB `singularity-main-thread-stall`, postMessage/popup names `singularity.auth.complete`, `singularity-auth`, `singularity-agent-browser`, `SPARE_LOCK_REASON` | stored rows, archives, browser-local data, live cross-version wire | stored / wire | **Keep the ids**. Their labels already say equin (step 4) |
| GitHub repo `Conchylicultor/singularity`, main checkout dir name | external | outward-facing | **Keep** (user) |

**The end state, enforced:** every kept spelling is a named constant in ONE leaf, `framework/product-name`'s `LEGACY_IDS` (beside `LEGACY_PRODUCT_NAMES`). Each consumer imports it rather than spelling the literal. A `product-name:legacy-id` check bans lowercase `singularity` in every tracked file except that leaf, `research/`, and the exact uses that leaf declares. This is the same pattern as `product-name:legacy` / `namespace:legacy-host` / `cli:legacy-cli-name`. So "is this name kept?" has one answer, written in one place, and a new `singularity` cannot creep back in.

## Steps (each one session, filed one at a time)

### Step 5 — code names + legacy-ids owner + namespace display (one mechanical session)
- `LEGACY_IDS` in `plugins/framework/plugins/product-name/core`: namespace, PG user/base DB, keychain service, codesign identifier, trailer keys, git config keys, git-dir lock names, stable ids. Route the existing consumers through it (`namespace.ts` `MAIN_COMPOSITION_ID`, `embedded/shared/internal/paths.ts`, `pgbouncer/scripts/start.ts`, `key-store.ts`, `remotes/core/internal/cache.ts`, trailer readers/writers in `cli/plugins/push`, `stats/commits`, `commit-conversation`, …). Go/Rust spellings get a `*-in-sync` check, like `namespace:grammar-in-sync`.
- Package scope: change the prefix in `plugin-id.ts`, regenerate the package.json names and bun.lock (`./equin build`); the package-names test follows. Rename the `"singularity"` key → `"equin"` (readers in plugin-tree + structure facet). Rename the camelCase names and files (`singularity.generated.ts`, tmp prefixes).
- Namespace display: add `namespaceLabel(ns)` in `infra/namespace/core` (= `NAMESPACE_HOST_LABELS[ns] ?? ns`) for every place a namespace is shown (logs worktree picker, worktree-identity row, deploy output). Have `query_db`'s `database` and any namespace-typed CLI flag resolve through `NAMESPACE_HOST_ALIASES`, so "equin" works and the docs and tool descriptions can say "equin".
- Add the `product-name:legacy-id` check. Docs sweep for the identifiers above (not `~/.singularity` / `SINGULARITY_*` yet; those move in steps 6–7).

### Step 6 — env vars, dual-read
- The launcher's `runtime-env.ts` already declares the forwarded names as data. Extend that idea to every var: one registry of `{ name: "EQUIN_X", legacy: "SINGULARITY_X" }`, one `readEnv(key)` that tries the new name and then the legacy one (TS, plus a Go and a Rust mirror held in sync by a check), and writers/launchers that set **both** names. The gateway's `-child-env` lists both. The gateway-drift health row then flags installed plists as older, which is the honest signal to run `./equin start --force`.
- Sweep the reads onto the registry. A check bans a raw `process.env.SINGULARITY_` / `process.env.EQUIN_` read outside it.
- A later step (filed only once it lands) drops the legacy names, after every install has restarted on the dual-read code.

### Step 7 — data dir + service label (standalone, run while nothing else runs)
- Resolution rule, in every runtime: `EQUIN_DIR ?? SINGULARITY_DIR ?? (exists ~/.equin ? ~/.equin : exists ~/.singularity ? ~/.singularity : ~/.equin)`. New installs get `~/.equin`; existing installs keep working untouched. TS `resolveDataRoot`, Go `dataRoot`, Rust, install.sh and the sidequest scripts are held to the same rule by a check.
- `./equin data-dir migrate`, run by the user: it refuses while any op or agent is running (the ops ledger). Then it stops the service, `rename(~/.singularity → ~/.equin)` (atomic, same filesystem), leaves the symlink `~/.singularity → ~/.equin` (every absolute path already stored — database.json, pgbouncer.ini, the registry, deps-cache envs — keeps resolving), reinstalls the service under `dev.equin.gateway` (removing the old plist/unit), and starts it. Known cost: bundle-less binaries under the cache are TCC-keyed by path, so they re-prompt once.
- Docs then say `~/.equin/`.

## Verification
- Step 5: `./equin build` (regenerates the package names and the lock), `./equin check` (new check green, `plugins-registry-in-sync`, `type-check`), `./equin test plugins/framework/plugins/plugin-id plugins/plugin-meta/plugins/plugin-tree`; `query_db` with `database: "equin"` returns main's rows; the logs picker shows "equin" (screenshot.ts).
- Step 6: unit tests of `readEnv` (new wins, legacy fallback); a backend launched by an old gateway (SINGULARITY_* only) still boots — exercised by building a worktree while main's gateway is on the old code.
- Step 7: the migration rehearsed in `sidequests/clean-install` (fresh install → `~/.equin`; old layout → migrate → service up, `http://equin.localhost:9000` serves, old absolute paths resolve through the symlink).

## This task's remaining output
Publish this decision on the track page (status + checklist; sub-steps 5–7 under the Decision item), and file Step 5 as the next main task.
