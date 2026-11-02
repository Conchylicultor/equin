# Portability derived from the import closure, not a `portable: true` flag

Track: wiki "Subtrack: portable server code (server/ vs machine/)" (block-323b766d-7ddf-4555-820a-80d82d6737f3), the next item of the "[Framework] Adding an app to the demo is (almost) no manual work" list. Previous item: research/2026-10-28-global-portable-retention-and-warmup.md.

## Context

Whether a server barrel can run in a browser host is a hand-set `portable: true` on its default export (239 of 539 `server/index.ts` barrels set it). The build already computes the true answer: `boundaries:portable-closure` measures every claim's static closure, and the coverage guard says "nothing in its closure needs the computer: flip it" when a needed barrel is clean but unflagged. When Pages joined the demo, starred, page chips and the search engine were changes to the flag alone. Every new app joining the demo repeats this, and the flag can be stale both ways: unset on a clean barrel, which the guard catches only when the demo needs it, or set and then contradicted. The second case is what the closure check exists to catch.

The flag was kept on 2026-10-20 (D2 of research/2026-10-20-global-config-v2-portable-and-inferred-host-graph.md) because deriving it "would silently admit 11 more barrels (e.g. `infra/mcp`)". This plan settles that point with a rule, a one-time review and a reviewed artifact; see D3.

**Outcome:** `portable` is a fact the build derives from the closure. The field is gone from `ServerPluginDefinition`, so it cannot be written. Every reader asks one memoized primitive, and adding an app to the demo needs no portability edits.

## Today's readers of the flag

The flag has one reader, `isPortableServerBarrel(source)` (`plugin-meta/parse-utils/core/portable-barrel.ts`, a static read of the default export's top-level field). Its consumers:

| # | Where | Use |
|---|---|---|
| 1 | `server-core/core/browser-host.ts:111` (`bootBrowserHost`) | Runtime: throws if a booted plugin lacks `portable: true` |
| 2 | `boundaries/check/portable-closure.ts` | Measures each claim: one `Bun.build` per flagged barrel, about 239 a pass |
| 3 | `boundaries/check/portable-own-barrels.ts:86` | Bans deep own-folder imports in flagged barrels' `server/` files |
| 4 | `server-core/check/index.ts:79, 95` (`host-services:provider-placement`) | A portable provider must be a `base-exclusions` negative; a service declared in a non-portable barrel needs no browser candidate |
| 5 | `codegen/core/browser-host-gen.ts:217` (`resolveHostGraph`) | Picks roots and provider candidates; the guard's "portable, but…/not portable" message |
| 6 | `codegen/core/browser-host-coverage.ts:1154` (`serverBarrelBlockers`) | A reached barrel without the flag counts as a blocker; an empty blocker list gives "flip it" (lines 1281, 1448) |

Hint text naming the flag: `machine-portable-declaration.ts:142`, `config_v2/check/registrations-paired.ts:90`, `codegen/check/index.ts:116`, `config-origin-gen.ts:87`. Test fixtures: `browser-host-gen.test.ts`, `browser-host-coverage.test.ts`, synthetic registry entries in `write-page-tree.test.ts`, `prototypes/fixtures/write.test.ts` and `lumen/bin/browser-host.test.ts`. `write-page-tree.test.ts`'s `portableClosureOf` calls `isPortableServerBarrel`. 19 hand-written `.md` files also mention the flag.

## Design

### D1. One fact: `serverPortability`, a taint over one union closure

A new primitive in `framework/tooling/plugins/boundaries/core/portability.ts`, next to `platform-apis.ts`, which already defines "needs the computer":

```ts
interface ServerPortability {
  /** Every server barrel measured. */
  barrels: readonly string[];
  isPortable(barrel: string): boolean;
  /**
   * Why `barrel` is not portable: each module in its closure that needs the computer,
   * with the specifiers / host-only values it uses and the shortest import chain
   * from the barrel. Frontier-pruned by plugin, at most a few. Throws for a portable barrel.
   */
  offenders(barrel: string): Offender[];
}
serverPortability(root, barrels, read): Promise<ServerPortability>
```

- **Semantics.** A barrel is portable iff its static closure (`dynamicImports: "cut"`, the bundler's own resolution) holds no module that needs the computer. A module needs it in one of three ways:
  1. It imports a platform API (`isPlatformApi` on a runtime import, the `loadsAtRuntime` reading).
  2. It uses a host-only value (`platformValueUsesIn`).
  3. **It declares a host service that no browser candidate provides** (new). A service with only a `machine/` provider is a computer-only API reached through a seam. Today this is the hand opt-out in `server-core/CLAUDE.md:214`: "a service declared in a non-portable barrel needs no browser candidate until that barrel turns portable". The review found 2 of the 100 clean-but-unflagged barrels in this case: `infra/claude-cli/accounts` (`ActiveClaudeAccount`) and `apps/deploy/deploy-secrets` (`DeploySecretSource`). Deriving without rule 3 would fail `provider-placement` and the demo graph ("has no provider"). The browser candidates are the `base-exclusions`-negated server barrels that provide the service and are themselves portable, so the computation is a monotone fixpoint: import taint first, then taint the declaring modules of services with no untainted candidate, re-propagate, and repeat until stable. The offender line reads "declares host service X, which only `machine/` provides".

  `machine/` is out of scope, as today. `moduleNeeds`, `loadsAtRuntime` and the per-module `platformOffenders(root, entry, …)` move from `portable-closure.ts` into this module and stay exported: `boundaries:machine-portable-declaration` (`machine-portable-declaration.ts:8,126`) runs them on arbitrary `machine/` modules, which are not server barrels.
- **One `Bun.build`.** `importClosures` (`tooling/import-closure`) over every server barrel at once. The edge record already exists; `UnionImportClosure` gains `children(module): string[]`, the repo-relative resolved children, resolved lazily and memoized like `chainThrough`'s `resolved` map. Taint is a reverse BFS from the offending modules over reversed edges, which handles cycles. A barrel is portable iff it is untainted. `offenders(barrel)` is a forward BFS from the barrel to tainted leaves, run only when a message needs it.
- **Cost.** Measured by the review with a read-only probe: one union `Bun.build` over all 539 server barrels loads 4,610 modules in 16 s warm and 25 s cold. A single barrel takes about 0.9 s, and today's portable-closure runs about 239 of them each pass, plus one per `serverBarrelBlockers` call. Lazily resolved union edges gave the same reachability as `importClosure` on 45 sampled barrels (0 mismatches, 0 resolve failures). The per-module scan is memoized, and the TS AST pass (`platformValueUsesIn`) runs only on modules whose text names a platform global or `.unref(`.
- **Memo.** One shared promise per repo snapshot: a `WeakMap<RepoFiles, Promise<ServerPortability>>` in `boundaries/core`. `buildRegistryGenContext` is already a `WeakMap` on the same `RepoFiles` (`plugin-registry-gen.ts:438`), so codegen's consumers, `provider-placement` (already through it) and `portable-own-barrels` share one derivation per process. An input-keyed check gets its own recording `RepoFiles` (`runner.ts:679`) and would pay again; none of the readers is input-keyed. `./equin build` and `./equin check` are separate processes and pay once each.
- **Freshness.** The union build reads disk, `*.generated.ts` included. `browserHostInfer` must run after the registry generators in the regen pipeline, which is true today for the member closures; re-confirm it.
- **Scope.** All server barrels, not only a composition's. Provider placement and own-barrel hygiene are repo-wide facts, and one build over everything costs no more than today's member union plus the 239 per-claim builds.

### D2. The flag is deleted, so it cannot be written

- Remove `portable?: true` from `ServerPluginDefinition` (`server-core/core/types.ts:222`) and its `Omit` in `MachinePluginDefinition`. A barrel still spelling it fails tsc as an excess property.
- Delete it from all 239 barrels mechanically, with an AST- or `parseBoolField`-located edit, not a regex. Delete `isPortableServerBarrel` and its export.
- Delete the `boundaries:portable-closure` check: there is no claim left to measure. Its job moves to D3. Its `platformOffenders` / `Offender` move into D1.

### D3. Who requires portability: the consumer, not the plugin

Portability matters only where a browser host needs it, so failures come from the consumer:

- **Graph roots** (`resolveHostGraph`): every bundle barrel that `serverPortability` says is portable, plus portable barrels loaded by the entry's seed. `HostGraphInputs` takes `portable(barrel)` as an input next to `closure`, so tests inject a set instead of writing flag text. The guard keeps "the graph loads X, which is not portable", now with D1's offenders and chain.
- **Coverage guard** (`serverBarrelBlockers`): rewritten over D1's `offenders`, with the "flip it" branch deleted. A non-portable barrel always has at least one offender (assert). The rule is now transitive and the same as the graph's: today the guard scans only the barrel's own `server/` files plus flagged/unflagged barrels, which is what produced "flip it".
- **Visibility of membership changes.** The worker graph (`bin/browser-host.generated.ts`, `hostEntries`) is committed and held by `plugins-registry-in-sync`. A plugin that drops out of the worker because a new import made it non-portable, or that joins because it became clean, shows up as a diff of that file in the same change. That replaces the per-plugin flag with a reviewed artifact per host. If the dropped plugin served anything the demo reads, the coverage guard fails loudly with the chain.
- **No per-plugin opt-out.** A barrel that is portable by its imports but desktop by meaning gets one of two fixes. Its desktop part moves to `machine/`, behind a host service or as a `needsMachine` declaration, which is the existing rule. Or its composition leaves it out (`agent-manager-demo` already excludes surfaces that mean nothing without the computer). A `desktopOnly` flag would bring back the hand-set state this task removes.

### D4. The other readers swap their predicate

- `bootBrowserHost` (`browser-host.ts:108-116`): delete the runtime assert. The graph is portable by construction (D3). `assertPortableArtifacts` (`worker-link.ts:293`) still rejects platform import specifiers in the bundle, but it does not see host-only values; those are guarded only by the derivation, as before. The comment says so.
- `host-services:provider-placement`: `isPortable` from D1, for both the misplaced-provider rule and `browserReachable`. With rule 3 the two agree by construction. **New assertion:** every `base-exclusions`-negated server barrel that provides a service must be portable, with D1's offenders and chain. Until now `portable-closure` gave this guarantee on the flagged candidates (all 16 server `.provide(` barrels are flagged today); without it, a tainted candidate would vanish with only "0 browser candidates" and no chain.
- `boundaries:portable-own-barrels`: same rule, over D1's portable barrels. Newly portable barrels may surface deep own-folder imports; fix them, which is mechanical and is the rule's purpose.
- Hint texts: "make it portable" now means "remove what needs the computer from its closure (move it to `machine/`)", never "set the flag".
- `write-page-tree.test.ts`'s `portableClosureOf`: use D1, or the generated `hostEntries`, instead of the flag.

## Steps

0. **Measure first** (read-only script, `./equin run`): compute D1 over today's tree and compare with the flags. It reports:
   - (a) flagged but tainted. This must be empty, since the closure check passes on main.
   - (b) clean but unflagged, overall and inside `agent-manager-demo`'s bundle: the graph delta. The review's probe found 100 repo-wide and at least 17 in the demo, among them `infra/mcp`, `infra/spawn`, `infra/secrets`, `infra/boot-snapshot`, `tasks/orchestration/mandate`, `tree-digest`, `page/cover`, `page/attachment-block` and several `reports/*`.
   - (c) barrels made non-portable by rule 3 alone, expected to be `claude-cli/accounts` and `deploy/deploy-secrets`.
   - (d) the deep own-folder imports `portable-own-barrels` would newly report.
   - (e) the time of the single build.
1. **Primitive:** `import-closure`'s `children`, plus `boundaries/core/portability.ts` (`serverPortability`, offenders, the memo), with unit tests on a fixture tree: a cycle, a type-only import, a dynamic import cut, a host global used as a value, and the offender chain.
2. **Consumers:** `resolveHostGraph` (`portable` input), `serverBarrelBlockers` / `whyOutside` / the contributions arm (drop "flip it"), provider-placement, own-barrels, and the hint texts. Update the `browser-host-gen` and `browser-host-coverage` test fixtures to inject portability instead of writing the flag.
3. **Delete:** the type field, the 239 flags, `isPortableServerBarrel`, the `portable-closure` check, the boot assert, and the runtime `portable: true` in synthetic test entries.
4. **Review the graph delta from step 0(b)** (user decision 2026-11-02: admit and review, no frozen list). For each barrel the demo's worker newly boots, read its `register` / `onReadyBlocking` / `onReady` / `onSettled`, its jobs, warm-ups and routes for anything desktop by meaning. Candidates: `infra/mcp` (MCP tool registry), `infra/boot-snapshot`, `tasks/orchestration/mandate` and `tree-digest`. Per D3, either admit it as-is, move the desktop part to `machine/`, or exclude it in `agent-manager-demo` (`plugin-meta/composition/core/config.ts:377`) when it means nothing without the computer. The lumen boot test and the demo e2e must pass with the admitted set. Record a table of each newcomer → its decision → why in this doc's Outcome, with worker size and boot time before and after.
5. **Docs:** server-core, codegen, boundaries, composition and lumen `CLAUDE.md`s, plus the 19 `.md` mentions (`rg 'portable: true'`); regenerate plugin docs through `./equin build`.
6. **Wiki:** a status entry on the subtrack page, the item's box ticked, and the next main task filed (the fixed-value host-service provider helper) with the page id and its instructions id.

## Verification

- `./equin check`: `type-check` (no barrel can spell `portable`), `plugins-registry-in-sync` (the regenerated `browser-host.generated.ts` diff is exactly step 0(b) after step 4's decisions), `host-services:provider-placement`, `boundaries:portable-own-barrels`, `browser-host:contributions-covered` and `config-v2:registrations-paired`.
- `./equin test` on `framework/tooling/plugins/boundaries`, `framework/tooling/plugins/import-closure`, `framework/tooling/plugins/codegen`, `apps/website/plugins/demos/plugins/lumen` (boots the derived graph on PGlite: warm-ups, sweeps, hostReads), `apps/pages/plugins/fixtures`, `apps/prototypes/plugins/fixtures` and `tasks/plugins/task-category`.
- Negative probes, temporary and reverted: (1) add `import "node:fs"` to a hub the demo reaches, e.g. a `page/editor` server file: the build fails with the chain from the graph, without any flag; (2) drop one flagged-only plugin's flag on main and see the derived graph still holds it, the "flag-only change" case gone.
- `./equin build`, then the demo e2e: `no-leak` (31/31), `prototypes-in-demo` (27/27), `app-switch` (24/24).
- Measurements for the wiki: worker size before and after, graph nodes before and after, check-pass time for the portability work before (about 239 builds) and after (one), and the build's `browserHostInfer` span.

## Risks

- **New plugins in the worker** (at least 17). Covered by step 4's per-plugin review, the boot test and e2e, and from then on by the committed `hostEntries` diff.
- **Build time.** The union build takes 16 to 25 s, against a member-only union today inside `./equin build`. If the build's `browserHostInfer` span grows noticeably, the codegen path measures only the composition's barrels, the candidates and the seed through the same primitive (rule 3 needs only the candidates); the checks keep the full set. Measure before choosing.
- **A wider rule in the coverage guard.** The guard's blockers become transitive like the graph's: a `core/` or `shared/` module of another plugin can now taint a barrel. This is correct (the bundle loads them), and the messages change accordingly.

## Outcome (implementation notes)

Steps 0 to 5 landed (step 4, the per-plugin review of the newcomers, below); step 6 (wiki) is separate.

### Step 0 measurements (read-only, before the flags were deleted)

Measured by `boundaries/scripts/measure-derived-portability.ts` (kept, without the flag comparison, as an ongoing diagnostic).

- 539 server barrels; 239 flagged; 336 derived portable.
- (e) One union `Bun.build` over all 539 barrels: 4,611 modules in 11.7 s (warm); the derivation itself (per-module scan, reverse taint, rule-3 fixpoint) 1.5 s.
- (a) Flagged but tainted: **0**.
- (b) Clean but unflagged: **97** repo-wide. Inside `agent-manager-demo`'s bundle: **25** — exactly the 25 entries the regenerated `lumen/bin/browser-host.generated.ts` gained (no provider change, `hostProviders` and `hostReads` unchanged):
  `fields/{bool,date,number}/text-cast`, `infra/boot-snapshot`, `infra/mcp`, `infra/secrets`, `infra/spawn`, `page/attachment-block`, `page/cover`, `reports/{adaptive-bar, caret-flight, collab-hydration, icon-family-gap, live-state-stale-drop, main-thread-stall, optimistic-divergence, optimistic-rejection, page-undo-conflict, panel-overflow, render-loop, resource-errors, theme-resolution, viewport-escape}`, `tasks/orchestration/mandate`, `tasks/orchestration/tree-digest`.
- (c) Non-portable by rule 3 alone: **3** — `apps/deploy/deploy-secrets` (`deploy-secrets.source`), `apps/deploy/site-messages/intake` (through `deploy-secrets`), `infra/claude-cli/accounts` (`claude-accounts.active`).
- (d) Deep own-folder imports newly reported by `boundaries:portable-own-barrels`: **14 in 6 plugins**, all fixed by importing the barrel — `apps/events/events-core` (1), `apps/sonata/library` (8), `apps/sonata/look` (1), `apps/sonata/pitch-layout` (1), `apps/sonata/track-mixer` (1; `trackViewEntityRef` / `trackViewServerFields` now exported from its core barrel), `integrations/hooktheory` (1; `parseOrThrow` now exported from its core barrel).

### Deviations

- **Rule 3's candidate set is every portable `server/` barrel that provides the service, not only the `base-exclusions`-negated ones.** Computing the negatives needs the composition config and the plugin edge graph (codegen), which `boundaries/core` cannot import without a cycle (codegen imports boundaries). The two sets are equal whenever `host-services:provider-placement` passes — it already fails on a portable provider outside the negatives — so portability stays a pure fact of the code. The new placement assertion (every negated provider is portable, with offenders and chains) is in that check as designed.
- The host-service text parsers (`parseHostServiceDeclarations`, `providedServiceNames`, `hostServicesByName`, `HostServiceDecl`) moved from `codegen/core/host-services.ts` to `parse-utils/core`; codegen keeps `baseExclusionServerBarrels`.
- `Offender.specifiers` is now `Offender.needs` (it also carries host-only values and rule-3 services).
- `serverBarrelBlockers(portability, barrel)` is synchronous over `offenders`; callers pass `await serverPortabilityOf(repo)`.
- The derivation's module scan yields to the event loop every ~10 ms (`yieldMacrotask`): the first build's check pass reported a 1.6 s check-thread stall attributed to `derivePortability`.

### Validation

`./equin build` green (worker graph +25, the list above); full `./equin check` green. Tests: boundaries, import-closure, codegen, pages/fixtures, prototypes/fixtures and task-category pass. The lumen boot test's one failing case at the time ("each seeded history holds its steps, and a version's files are served") came from main, not from this change: since content isolation (958848cfd4) a version's served `index.html` carries the injected frame agent. b2ee45762d fixed the same assertion in `prototypes/fixtures/write.test.ts`; this change fixed it in the lumen test too (it now expects `injectFrameAgent(…)`). Re-run after step 4: the lumen boot test passes in full (its child process runs all 32 cases; the parent asserts exit 0).

## Step 4: newcomer review

User decision 2026-11-02: admit and review. Each of the 25 barrels the demo's worker newly booted was read for its `register` / lifecycle hooks / jobs / warm-ups / routes. 23 admitted as they are; 2 split.

| Plugin | Decision | Why |
|---|---|---|
| `infra/boot-snapshot` | admit | One route (`GET` boot snapshot), no lifecycle. In the demo the page hydrates from its own server, so the worker's route is dead but correct. |
| `infra/spawn` | admit | Its `server/` barrel imports nothing (the impl is `core/`); a description only. Inert. |
| `tasks/orchestration/mandate` | admit | Registers the `## Mandate` MCP instructions section (into a registry nothing serves in the worker, see `infra/mcp`) and serves the `mandate.capabilities` catalog value, which is meaningful for the demo's task surfaces. |
| `tasks/orchestration/tree-digest` | admit | Functions only (`treeDigest`, `taskTree`), no lifecycle; called only from MCP tools / instructions. Inert. |
| `page/attachment-block` | admit | The block↔attachment reconcile job on `blocksChanged`: meaningful in the browser (the demo's pages keep their attachment links, as on the desktop). |
| `page/cover` | admit | A collector contributed to that reconcile, so a cover is not orphan-swept. Meaningful. |
| `fields/{bool,date,number}/text-cast` | admit | `Fields.ValueTextCast` contributions: the SQL casts server-delegated DataView filters and sorts need. Meaningful (the worker's DataViews filter on PGlite). |
| `reports/adaptive-bar`, `caret-flight`, `collab-hydration`, `icon-family-gap`, `live-state-stale-drop`, `main-thread-stall`, `optimistic-divergence`, `optimistic-rejection`, `page-undo-conflict`, `panel-overflow`, `render-loop`, `resource-errors`, `theme-resolution`, `viewport-escape` | admit | Each a single `ReportKind` (validate the payload, fingerprint, render a task); no lifecycle, jobs or routes. The reports engine already runs in the worker, so these only let it accept their kinds. Harmless. |
| `infra/mcp` | split (`machine/`) | It joined only because `mandate` imports `Mcp` to register its section. The route (`handle-mcp.ts`, `instructions.ts`, `isolate.ts`, `scope.ts`) and the `mcp.catalog` / `mcp.health` values (`catalog.ts`, `health.ts`) moved to `infra/mcp/machine`, which pulls `@modelcontextprotocol/sdk` (+ ajv). `server/` keeps only the SDK-free registration API (`Mcp`, the types, `registry.ts`) and stays in the worker. `mcpRequest`, `mcpCatalog` and `mcpHealth` declare `needsMachine`; Debug → MCP tools and the health row's MCP verdict render the unavailable state (`not-applicable`) on a host without the computer. |
| `infra/secrets` | split (host service) | Every operation was `callEndpoint` to central at `http://localhost:9000` (in the website demo, the visitor's own machine). `getSecret` / `setSecret` / … now go through the `SecretStore` host service (`secrets.store`, declared in `secrets/server`); its one provider is `infra/secrets/machine` (`centralSecretStore`, the former central client). With no browser provider, rule 3 makes `infra/secrets/server` non-portable and it drops out of the worker. |

Deviation: two processes run code that reads a secret **without booting a graph** — the agent process (`conversations/runtime-sdk/bin/agent.ts`, an added account's token) and `./equin deploy` (`cli/deploy`'s `resolveTarget`, the server's SSH key). Each names the provider itself, `provideHostServicesUnbooted([SecretStore.provide(centralSecretStore)])`. A `bin/` cannot import `machine/`, so `centralSecretStore` is also exported by a new command-less `infra/secrets/cli` barrel (the `server-core/cli` precedent). Any other bare process that reaches a secret read would now fail loudly at `get()` ("read before boot collected contributions") instead of calling central; none other was found by import search.

### Measurements (step 4)

Worker = the lumen host's worker tree in the web-artifacts store (`worker-tree.<hash>`, the dist's `@browser-host-worker/…` import-map target): every linked artifact's `*.js`, plus the `_vendor` files reachable from them (`.br` sizes in brackets).

| | Graph nodes (`hostEntries`) | Linked artifacts | Code | Vendors reached | Total |
|---|---|---|---|---|---|
| main (`worker-tree.f6c8ffa567e81e87`) | 230 | 515 | 3,905,749 B | 45 files, 1,946,311 B | **5,852,060 B** (1,384,437 br) |
| +25, before the splits (`worker-tree.55e789df22cb7704`) | 255 | 557 | 4,022,774 B | 54 files, 2,272,715 B (5 `@modelcontextprotocol/sdk` entries + ajv) | 6,295,489 B (1,512,500 br) |
| after the splits (`worker-tree.e1c78f84d81d26ba`) | 254 | 554 | 4,008,173 B | 45 files, 1,946,311 B (no SDK, no ajv) | **5,954,484 B** (1,420,603 br) |

The worker's `infra.mcp.server` artifact now imports only `server-core/core`. Net cost of the 24 newcomers that stayed: +102 kB raw (+36 kB br), all repo code; the vendor set is main's exactly.

### Validation (step 4)

- `./equin build` green; full `./equin check` green (170 checks).
- `./equin test` on boundaries, import-closure, codegen, `infra/mcp`, `infra/secrets`, pages/fixtures, prototypes/fixtures, task-category, lumen, `debug/mcp-tools`, `config_v2`: 462 pass, 47 skip, 0 fail. `portability.test.ts` gained fixtures for a two-round rule-3 chain, frontier pruning (own-plugin seeds all named, one per foreign plugin, none behind a seed) and an in-repo type-only import of a tainted barrel; `platform-apis.test.ts` asserts `mayUsePlatformValue` on every positive case. task-category's portable boot was failing before this step (config_v2 in its closure, through model-provider, had no provider in the harness): it now boots with `config_v2/browser-store` and the committed layer read off disk, a helper shared with prototypes/fixtures (`config_v2/server/testing`'s `diskConfigGitLayer`).
- Demo e2e: `no-leak` 31/31 (after fixing its prerequisite step's `/^Launch/` button, ambiguous since the draft form's submit was renamed "Launch" on 2026-10-30: it now targets "Launch ⌘↵"); `app-switch` 24/24 (one flaky run failed at the launcher hover, the rerun passed); `prototypes-in-demo` 27/27 on a rerun (an earlier run under host load failed from "the launcher offers Prototypes" on; main's deploy passes the same steps, its one failure a 403 from main refusing agent writes).
- Desktop smoke on this build: Debug → MCP tools lists 38 tools from 19 plugins, 3 instructions sections and the scope resolver (the catalog's in-memory SDK listing, now in `machine/`); `POST /api/mcp/<conv>` answers `initialize` (server `equin`, with instructions) and `tools/list` (a temporary e2e script over `pageFetch`, removed).
