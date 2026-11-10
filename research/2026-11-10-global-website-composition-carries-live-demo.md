# The standalone website composition carries the homepage's live demo

Task: att-1794271516-gvbyvv. Track: "apps running in the browser, on fake or local data"
(page block-d04c6c0d), item "[Composition] The website composition compiles the embedded
apps' server halves into the browser".

## Context

Main's `/website` shows the live demo band (`apps/website/landing/screenshot`:
`<DemoScope>` + `<AppEmbed>` over `apps/website/demos/workspace`). The standalone `website`
composition (equin.ai alone) still subtracts it (`!apps.website.demos.**`,
`!apps.website.landing.screenshot`), because with the band in, `composition-closure` fails:

```
composition "website" excludes bundle "agent-runtime" but its closure includes 61 plugin(s)
  apps.website.demos.workspace →(core/ import) conversations
  conversations →(server/ import) apps.agent-manager.shell
```

Two separate problems hide behind that one failure:

1. **A data import drags the desktop app in.** The band needs only `workspaceDemo` (the
   scenario: app, route, browser host). The workspace demo's `core/` also exports the demo's
   story data, which imports constants from `conversations`, `tasks`, `page`, `wish`, …
   cores. Reaching a plugin through one barrel bundles all of it, its desktop `server/` and
   `machine/` halves included, which reach the agent runtime.
2. **The demo's page side is not in the site's bundle at all.** `<PluginScope>` only *filters*
   the page's registry down to the host composition's web plugins (`browserHost.plugins`,
   864 of them). On main every plugin is in the page's registry, so this works. On the
   standalone site, the scope's plugins (the agent manager's, Pages', Sonata's web halves)
   are not in the registry, so the demo would render nothing. Their *server* halves must
   not join the site either: they already run in the worker (`@browser-host/<plugin>`).

## Design

The rule: **a composition that bundles a browser host's declaring plugin carries that host's
page scope in its web registry, and nothing else of it.** The scope's web plugins are
loaded on demand by the scope, are invisible to the page outside the scope, and their
server / machine / central halves stay out of the composition's backend. Their reads and
calls already go to the worker. Anything that leaks to the page's own server finds no route
there and fails with a loud 404.

### 1. Split the demo's story out of its scenario (inexpressible leak)

- New child plugin `apps/website/demos/workspace/plugins/story`, `core/` only: today's
  `workspace/core/internal/{stories,pages,transcripts,prototypes,songs,places}.ts`, and
  `places.test.ts`, with the barrel re-exporting what `workspace/core/index.ts` exports now
  (minus `workspaceDemo`, `WORKSPACE_DEMO_STORAGE`, `externalHosts`).
- `workspace/core` keeps `workspaceDemo`, `WORKSPACE_DEMO_STORAGE`, `DEMO_CONVERSATION_ID`
  (scenario) and the generated `browserHost` / `externalHosts`. Its closure is now the
  `demo` core types plus nothing.
- Importers move: `bin/seed.ts`, `bin/browser-host.test.ts`, `apps/demo/e2e/places-in-demo.ts`
  (`DEMO_PLACES`). `bin/` and `e2e/` run on no host, so the closure never follows them.
- Website row: drop `!apps.website.demos.**` and `!apps.website.landing.screenshot`.

### 2. The registry carries the scope: `scopedEntries` (codegen)

- `browser-host-gen.ts`: factor the cheap half of `inferUncached` (resolve the host's
  composition, then `bundle ∩ web barrels`) into `resolveHostScope(ctx, host)`, memoized on
  the ctx like the rest. `inferUncached` uses it, and so does the new
  `browserHostScopes(ctx, bundle)`, which returns the scopes of every host whose declaring
  plugin is in `bundle`.
- `generateCompositionRegistry` (web dir only): `scopeOnly = ∪ scopes ∖ bundle`. The web
  registry renders a second list, `scopedEntries` (same `CollectedEntry` shape, `dependsOn`
  pruned to own ∪ scoped paths). Every web registry exports it. Main's is `[]` (main bundles
  every plugin), so main's committed `web.generated.ts` gains only an empty export.
- web-artifacts' fleet plans targets for `webEntries ∪ scopedEntries`, so their artifacts
  and import-map entries exist.
- `composition-closure`'s `excludes` stays against `bundle`, which is what the site's
  backend boots. The scope is the browser host's, and the host's coverage guard already holds
  it to the worker.

### 3. Runtime: the page sees its own plugins, a scope loads its own (web-sdk + web-core)

- `PluginProvider` takes the on-demand set: the `scopedEntries` and a loader that App.tsx
  builds from its existing `loadPlugins` → `registry.append` → `markDeferredPluginsLoaded`.
- **The page root never sees a scope-only plugin.** The root reader excludes the on-demand
  ids (`excludingReader`), so their `Core.Root` mounts, apps and action-bar items never show
  on the site. `PluginScope` filters the *unfiltered* registry (a second context), not its
  parent, so inside the demo they are visible. On main nothing is on demand, so both readers
  are the registry and nothing changes.
- **Loaded on Enter.** `useScopePlugins(composition)` (web-sdk) returns
  `pending | ready | failed` and loads the missing scope plugins. `DemoScope` calls it once
  entered, in parallel with the worker's boot, and renders the scope when both are ready.
  Nothing downloads before Enter, as today. A failed load goes to the error boundary.
- **Loud, not lenient.** `PluginScope` throws when it is asked to render a composition whose
  on-demand plugins are not loaded. The loader refuses an on-demand plugin that contributes
  a `Core.Boot` task: it would run against the page's server, and no scoped plugin has one
  today.

## Constraint: the rest of the website stays as it is

The site's own plugins, bands, boot path and load cost are unchanged. The only new boot
work is the band's own plugin (already there on main) plus the empty `scopedEntries`. The
scope's 800+ web plugins load only after Enter, behind the existing progress bar.

## Verification

- `./equin check composition-closure` passes with the negatives gone, and
  `plugins-registry-in-sync` passes.
- `./equin test` on the web-sdk, the closure, codegen's browser-host-gen and the workspace demo.
- `./equin build`, then the website composition served from this checkout
  (`./equin build --composition website`): `live-demo.ts --url http://website.<wt>.localhost:9000`
  must pass, and the site must look the same before Enter (screenshots of `/website`).
- On this checkout's own build (main composition): every demo e2e script
  (`plugins/apps/plugins/demo/e2e/*.ts`, `no-leak.ts` included) and the website's
  `live-demo.ts`.
- Review subagent (sonnet) on `git diff $(git merge-base HEAD main)`.
