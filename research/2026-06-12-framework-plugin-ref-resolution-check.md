# Plugin-reference resolution check

## Context

Re-homing the 13 top-level leaf plugins under umbrellas surfaced a class of move-fragile
coupling: central registries and lint/check allowlists reference plugin **filesystem paths**
or **dot-ids** by string literal, with nothing that verifies those literals still resolve.
Relocating a plugin breaks them — some loudly (a build failure), most silently (a now-dead
allowlist entry that stops exempting the file it was meant to, or a reorder override whose
customization is dropped without error).

Concrete instances hit during the move:

| Reference | File | Form | Failure mode |
|---|---|---|---|
| `resolveFrom: "plugins/primitives/plugins/terminal"` | `plugins/plugin-meta/plugins/barrel-import/core/internal/auto-stub-packages.ts:7-9` | bare fs path | loud (build couldn't resolve `@xterm/xterm`) |
| `no-adhoc-spacing` ignores (~390 entries) | `plugins/primitives/plugins/spacing/lint/index.ts:32-423` | bare fs paths | silent (exemption lost → lint fails on moved file) |
| `no-raw-web-fetch` / `no-void-fetch-endpoint` ignores | `plugins/infra/plugins/endpoints/lint/index.ts` | bare fs paths | silent |
| `ALLOWED` prefix allowlist | `plugins/infra/plugins/endpoints/check/no-raw-json-handlers.ts:23-34` | bare fs path prefixes | silent |
| failure-message path | `plugins/apps/plugins/agent-manager/plugins/welcome/check/index.ts:40` | bare fs path | cosmetic (misleading message) |
| reorder override `pluginId:id` entryKeys | `config/**/*.jsonc` (46 files, 130+ keys) | dot-id | silent (committed layout dropped) |

**Root cause:** there is no single derived source of truth enforcing that a plugin path/id
string literal resolves. The fix is **one validating check** that flags any such literal that
no longer points at a real plugin — converting the entire silent-breakage class into a loud,
diagnosable check failure. Note we already *have* the derivation primitives; what's missing is
the enforcement.

## Existing primitives to reuse (no new infra)

- **`buildPluginTree(pluginsRoot, { skipBarrelImport: true })`** — `plugins/plugin-meta/plugins/plugin-tree/core`.
  Returns `byPath: Map<relPath, PluginNode>` (keys like `"primitives/plugins/terminal"`) and
  `byDir`, with each node carrying `.path` and `.id` (dot-id like `"primitives.terminal"`).
  Already used by the `plugin-boundaries` check.
- **`grepCode({ ..., maskStrings: false })`** — `plugins/framework/plugins/tooling/plugins/checks/core`
  (`grep-code.ts:35`). Scans source with string contents *visible* (default masks them); returns
  `CodeMatch` with file + line. This is exactly the "find inside string literals" mode we need.
- **`parse` from `jsonc-parser`** — already a dependency, used by config_v2
  (`plugins/config_v2/server/internal/jsonc-proxy.ts:11`). Parses the `// @hash`-prefixed
  reorder override JSONC.
- **`Check` interface** — `{ id, description, run(): Promise<CheckResult> }`, `CheckResult =
  { ok: true } | { ok: false; message; hint? }`. Built-in checks live at
  `plugins/framework/plugins/tooling/plugins/checks/plugins/<id>/check/index.ts` and are
  auto-discovered by codegen into `check.generated.ts` (no registry edit).
- **`getRoot()`** — the small per-check helper pattern (see
  `plugins/infra/plugins/endpoints/check/no-raw-json-handlers.ts:6`); copy it.

`plugin-boundaries` already validates `@plugins/...` *import specifiers*. This new check is the
complement: it validates plugin references that appear as **plain data** (bare `plugins/...`
paths and bare `pluginId:id` dot-ids), which nothing currently checks.

## Design

New built-in check, id `framework.tooling.checks.plugin-refs-resolve`, at:

```
plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-refs-resolve/
├── check/index.ts          # default-export the Check
└── CLAUDE.md               # required by plugins-have-claudemd
```

`run()`:

1. Build the tree once. Derive two lookup sets:
   - `pathSet = new Set(tree.byPath.keys())` — relative plugin dirs (no leading `plugins/`).
   - `idSet  = new Set([...tree.byDir.values()].map(n => n.id))` — dot-ids.

2. **Surface A & B — bare `plugins/...` path literals** (covers resolveFrom, both lint
   `ignores` lists, the `no-raw-json-handlers` ALLOWED prefixes, and the welcome message —
   all are bare-`plugins/` string literals in `.ts`):
   - `grepCode` over `plugins/**/*.{ts,tsx}` with `maskStrings: false`, matching the token
     `plugins/`. Exclude `*.generated.ts`.
   - From each match, extract every literal of the form `plugins/<seg>(/plugins/<seg>)*...`.
     Strip the leading `plugins/`, then compute the **maximal plugin-dir prefix** by walking the
     alternating `seg(/plugins/seg)*` grammar (stop at the first non-`plugins` interstitial —
     i.e. when a runtime dir like `web`/`server`/`core` begins). This naturally drops trailing
     file segments and globs (`/**`).
   - **Validate:** the extracted plugin-dir prefix ∈ `pathSet`. If not → violation.
   - **Extra (catches intra-plugin file renames in the burndown lists too):** if the full
     literal contains no glob char, also `existsSync(join(root, literal))`; missing → violation.
   - Restricting to **bare** `plugins/` (not `@plugins/`) cleanly excludes the thousands of
     import specifiers — those use the `@plugins/` alias and are plugin-boundaries' job.

3. **Surface C — reorder override `pluginId:id` entryKeys**:
   - For each `config/**/*.jsonc`, `parse` it (jsonc-parser), walk every `items` array, and for
     each **string** entry containing a `:`, split on the first `:` → `[pluginId, id]`.
     (Object entries like `{ "type": "spacer", ... }` and bare keys without `:` are skipped.)
   - **Validate:** `pluginId ∈ idSet`. If not → violation. (Validating the `id` half would
     require loading the live contribution catalog — out of scope; the *move* problem lives
     entirely in the `pluginId` half.)

4. Aggregate all violations into a single `{ ok: false, message, hint }`. `message` lists
   `relPath:line — "<literal>" (plugin <path|id> "<extracted>" does not resolve)`, capped
   (e.g. first 50, "+N more"). `hint`: "A plugin was likely moved or renamed — update these
   references to its new path/id." Omit `cacheSignature` (tree-deterministic → default caching).

### Detection precision

- The bare-`plugins/` heuristic is highly specific; the only strings starting with `plugins/`
  in `.ts` source today are genuine plugin path references. Globs (`**`), trailing slashes
  (`plugins/.../endpoints/`), and full file paths all reduce to a plugin-dir prefix correctly.
- If a legitimate non-plugin `plugins/...` literal ever appears, add a narrow, commented
  skip-set in the check (mirroring `plugin-boundaries`' `FRAMEWORK_FILES`) — **not** a blanket
  bypass.

## Files

**New:**
- `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-refs-resolve/check/index.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-refs-resolve/CLAUDE.md`

**Regenerated by `./equin build` (commit the result):**
- `plugins/framework/plugins/tooling/plugins/checks/core/check.generated.ts` — auto-discovers
  the new `check/index.ts`; enforced committed by `plugins-registry-in-sync`.

**Possibly edited (only if the new check surfaces pre-existing stale refs):** any current dead
entry in the tables above. This is expected and desirable — the check's first run is also an
audit of what's already broken.

## Verification

```bash
./equin build                                            # regenerates check.generated.ts
./equin check plugin-refs-resolve                        # new check: must pass green
```

End-to-end proof it catches a move (do, observe, revert — do not commit):

1. Temporarily rename a referenced plugin dir (e.g. simulate the terminal move by editing the
   `resolveFrom` literal to a bogus `plugins/primitives/plugins/terminalX`).
2. `./equin check plugin-refs-resolve` → must now **fail**, naming the file:line and the
   unresolved path.
3. Revert.

Also confirm no false positives across the whole repo on the clean tree (step 1 above green),
and that `./equin check` (full run) stays green.

Optional unit coverage: a `check/index.test.ts` (`bun:test`) exercising the prefix-extraction
helper against representative literals (bare path, file path, glob, trailing-slash prefix) and
the entryKey splitter — run with `bun test plugins/.../plugin-refs-resolve/check`.

## Out of scope (note for follow-up, do not build now)

- **Auto-deriving `resolveFrom`** from whichever plugin's `package.json` declares the dependency
  (would remove that literal entirely). The check makes it safe; the derivation is a separate
  cleanup.
- **Rewriting reorder override JSONC on plugin move** (a migration that re-keys `pluginId:id`).
  The check makes staleness loud; auto-migration is a larger, separate piece.
- Validating the `id` half of reorder entryKeys against the live contribution catalog.
