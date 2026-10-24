# Derive the eager plugin tier from declared markers (kill the allowlists)

> Status: approved plan. Track 4 of
> [2026-07-02-global-comms-structural-fixes.md](./2026-07-02-global-comms-structural-fixes.md).
> Companion: [2026-07-02-cold-deeplink-boot-saturation-deferred-loading.md](./2026-07-02-cold-deeplink-boot-saturation-deferred-loading.md)
> (whose "follow-up #1" this executes).

## Context

`DEFERRABLE_APPS` / `EAGER_EXCEPTIONS` in
`plugins/framework/plugins/web-sdk/core/load-tiers.ts` are hand-maintained
allowlists deciding which web plugins load before first paint. They have
broken twice (release boot-critical descriptors — patched by `146da4a80`;
sonata/voicing config registration), and their header comment is already
stale (it still claims studio has a diffuse release coupling that
`146da4a80` fixed). The must-be-eager set is derivable from declared facts;
this plan derives it at codegen time, makes **every** app deferrable by
default (studio and agent-manager flip), deletes both allowlists, and adds
an `eager-tier-in-sync` drift check plus a build-failing reachability
guard so the historical bug class is unrepresentable.

## Design

A web plugin must be eager iff one of four declared/derived facts holds:

1. **Structural** — it is not app content (`^apps/plugins/<app>/plugins/<child>`
   with `<child> !== "shell"`). Framework, primitives, shared domains, and
   every app's `shell` subtree stay eager (unchanged rule).
2. **Watched-slot contribution** — its files call a slot factory whose
   contributions are read by always-eager global chrome at boot:
   `Core.Root`, `Core.Boot`, `Apps.App`, `ActionBar.Item`. Detected by
   scanning each app-content plugin's `web/` (+ `core`/`shared`) files with
   parse-utils `findMarkerCalls` (masked source, genuine call sites, gated
   on the file importing the owning barrel). Scanning files — not the
   `contributions: [...]` block — is deliberate: contributions are often
   authored as `export const bootTask = Core.Boot({...})` in an internal
   file and referenced by variable in the barrel, which a block-only parse
   misses. False positives are safe (needlessly eager); false negatives are
   the bug class.
   - `ActionBar.Item` is watched because the global action bar renders on
     every app; a deferred item would pop in post-paint on all surfaces
     (bad UX). Today this pins exactly one app plugin:
     `apps/plugins/agent-manager/plugins/worktree-switcher`.
3. **Boot-critical resource descriptor** — the plugin's `core`/`shared`/`web`
   files declare a live-state descriptor with `bootCritical: true` (see
   single-sourcing below). Also enforces **reachability**: generation
   throws if the owning plugin has no web entry (the exact `146da4a80`
   bug — the fix is release's registration-only web barrel pattern).
4. **Transitive closure over `dependsOn`** — anything an eager plugin
   (transitively) imports is eager. `web.generated.ts` `dependsOn` already
   captures cross-runtime barrel imports, so e.g. the eager sonata shell's
   `useConfig(voicingConfig)` import of `@plugins/.../voicing/core` creates
   the edge that pins `voicing` — the `ConfigV2.WebRegister` coupling is
   derived from the import graph, with **no** need to watch that slot
   (watching it would needlessly pin ~10 sonata config plugins read only by
   deferred surfaces). ESM loads those modules anyway; the closure just
   makes their contributions available too, so an eager plugin can never
   observe a missing registration from one of its dependencies.

The generated artifact is the **deferred** set (fail-safe: unknown path →
eager): `plugins/framework/plugins/web-sdk/core/web-tiers.generated.ts`
exporting `DEFERRED_PLUGIN_PATHS: ReadonlySet<string>`, with a comment
block listing every app-content plugin pinned eager and why (debuggability).
`isDeferredPluginPath` becomes a membership lookup; `partitionWebEntries`
is unchanged.

### bootCritical single-sourced on the descriptor

Today `bootCritical` is a server-side flag on
`Resource.Declare(resource, { bootCritical: true })` (23 sites, 13 files),
while the client-side registration is a bare module side effect
(`resourceDescriptor()` call) — the one statically-invisible coupling.
Move the flag to the descriptor:

- `ResourceDescriptor` gains `bootCritical?: true`; the three factories
  (`resourceDescriptor` / `keyedResourceDescriptor` /
  `centralResourceDescriptor` in
  `plugins/primitives/plugins/live-state/core/resource.ts`) gain a trailing
  `opts?: { bootCritical?: true }`.
- `ResourceContract` + the returned `Resource` in
  `plugins/framework/plugins/resource-runtime/core/runtime.ts` carry the
  flag through the two-arg `defineResource(contract, serverOpts)`.
- `Resource.Declare` (`plugins/framework/plugins/server-core/core/resources.ts`)
  becomes single-arg and derives the payload's `bootCritical` from the
  resource object; the `opts` param is deleted, so a stale
  `Declare(r, { bootCritical: true })` is a **type error** forcing
  migration. `bootCriticalKeys()` in boot-snapshot is unchanged.
- Server/client drift becomes unrepresentable — the flag exists once, in
  the shared descriptor module the codegen scanner reads.

Migration of the 23 sites (verified inventory):

- **14 two-arg `defineResource(descriptor, opts)`** — add
  `{ bootCritical: true }` to the descriptor factory call, drop Declare
  opts: tasks/attempts/pushes/conversations* (tasks-core), releaseHistory,
  conversationGroups, queueRanks→(see flat), agents+agentLaunches,
  turnSummaries, conversationCategories, conversationPreprompts, etc.
- **6 flat `defineResource({...})`** — migrate to the two-arg form
  (descriptor already exists client-side): notifications
  (`shell/plugins/notifications`), queueRanks (conversations-view/queue),
  mainAheadCount + buildHistory (`build`), conversationProgress,
  conversationNotes. Verify the progress/notes descriptors live in
  `core`/`shared` (relocate if web-only, cycle-free).
- **3 `defineExternalResource({...})`** — add a two-arg
  `defineExternalResource(descriptor, serverOpts)` overload mirroring
  `defineResource`, then migrate: previewState (release), worktreeOps
  (op-status), frontendHash (build). Fallback if the overload proves
  invasive: keep server opts for these three plus a `bootcritical-in-sync`
  check asserting server-declared ⊆ descriptor-marked — but the overload is
  the target.

## Implementation steps

1. **Descriptor-level bootCritical** — live-state `core/resource.ts`,
   resource-runtime `core/runtime.ts` (contract + Resource +
   `defineExternalResource` two-arg overload), server-core
   `core/resources.ts` (single-arg Declare), migrate the 23 sites.
2. **`codegen/core/eager-tier-gen.ts`** (new, mirrors `fields-eager-gen.ts`):
   - `eagerTierManifestPath(root)`, `renderEagerTierManifest(root)` (may
     throw the reachability error), `generateEagerTier({root})`
     (write-on-diff).
   - Consumes the same disabled-filtered entries + pruned deps as the
     registry via a new export from `plugin-registry-gen.ts`:
     `collectEntriesWithDeps(ctx, dir)` (extracted from
     `renderCollectedDirRegistry`, which now reuses it — `web.generated.ts`
     stays byte-identical).
   - Seeds (a)–(c) above, then forward closure over deps, then
     `deferred = allWebPaths − closure`. Deterministic sorted output with
     pin-reason comments.
3. **Pipeline** — `regen-pipeline.ts` `regenerateRegistryCodegen`: add
   `generateEagerTier` step after `generatePluginRegistry` (shared by
   `build` and push-time `regen-generated`; thread the shared ctx to avoid
   a second tree walk if cheap).
4. **Rewrite `load-tiers.ts`** — delete `DEFERRABLE_APPS`,
   `EAGER_EXCEPTIONS`, `APP_CONTENT`, stale comments; import the generated
   set; `isDeferredPluginPath = set.has`. Drop `EAGER_EXCEPTIONS` from
   `web-sdk/core/index.ts` exports.
5. **`eager-tier-in-sync` check** — new check plugin at
   `tooling/plugins/checks/plugins/eager-tier-in-sync/check/index.ts`,
   byte-compare regenerate-vs-committed (mirror `fields-eager-in-sync`);
   try/catch so a reachability throw surfaces as a check failure at push
   time.
6. **Tests** —
   - `load-tiers.test.ts`: keep `partitionWebEntries` mechanics; replace
     allowlist tests with membership guardrails against the committed set
     (sonata/shell eager, sonata/notation deferred, sonata/voicing eager,
     studio content deferred, worktree-switcher eager, mail auto-resume
     eager).
   - `codegen/core/eager-tier-gen.test.ts` (bun:test, precedent
     `plugin-registry-gen.test.ts`): pure seed+closure logic on synthetic
     entries — structural rule, watched-slot pin, bootCritical pin,
     reachability throw, closure pull, deterministic output.
7. **Docs** — new load-tiers header; mark follow-up #1 done in the
   cold-deeplink research doc; Track 4 note in the super-plan doc.

## Expected tier diff (verification target)

- **Newly deferred**: all studio content except shell
  (`compositions, contributions, explorer, graph, membership-tint, release`),
  `agent-manager/plugins/welcome`.
- **Pinned eager (derived, was hand-pinned or hand-excluded)**:
  both new shells (Apps.App), `worktree-switcher` (ActionBar.Item),
  `mail/.../auto-resume` (Core.Root), `sonata/voicing` (closure from
  sonata/shell).
- **The 12 previously-deferrable apps must produce an identical deferred
  set** — any other diff means the model diverged from the hand list and
  must be reconciled before commit.

## Verification

1. `./equin build` — generation succeeds, `web-tiers.generated.ts`
   committed, checks green (`eager-tier-in-sync`, registry, docs, tsc).
2. Diff the generated deferred set against the old `partitionWebEntries`
   output (expected diff above, nothing else).
3. `bun test plugins/framework/plugins/web-sdk/core/load-tiers.test.ts`
   and the new eager-tier-gen tests.
4. Boot checks via scripted Playwright: cold deep link into agent-manager,
   studio, sonata, mail — first paint + no `BootSnapshotUnresolvedDescriptor`
   / "has no web registration" crashes; boot-profile pane sanity.
5. Negative test of the guard: locally delete `plugins/release/web/index.ts`
   → generation must fail with the actionable reachability error (revert).

## Rollback / safety

Fail-safe direction: a modeling gap makes a plugin needlessly eager
(slower boot), never wrongly deferred. Wrong deferral is caught loudly by
existing runtime guards (boot-snapshot crash report, config throw).
`web-tiers.generated.ts` is a committed deterministic artifact — rollback
is a revert + rebuild.

## Follow-ups (file as tasks, not in scope)

- Strengthen bootCritical reachability from "owning plugin has a web
  entry" to a plugin-local transitive import walk from `web/index.ts` to
  the descriptor module.
- Surface each plugin's tier (+ pin reason) in the Studio plugin-view pane
  (facet/docgen nice-to-have).
- Consider a lint/check that a config descriptor is defined in the same
  plugin that `ConfigV2.WebRegister`s it (closes the theoretical
  definer≠registrant evasion of the closure rule).
