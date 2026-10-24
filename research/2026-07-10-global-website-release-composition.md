# The `website` release composition — a lean, releasable public site

> Status: implementation plan. Category `global` (composition registry, sonata plugin split, release smoke-test).
> Parents: [`2026-07-07-plugins-website-equin-public-site.md`](./2026-07-07-plugins-website-equin-public-site.md) (§Phasing step 8),
> [`2026-06-14-global-composition-manifest-registry.md`](./2026-06-14-global-composition-manifest-registry.md),
> [`2026-06-20-global-web-release-target.md`](./2026-06-20-global-web-release-target.md) (F4).

## Context

The website app (`plugins/apps/plugins/website`) is the deployable unit for equin.ai, but it is the
only top-level app with **no composition manifest**. Without one there is no way to compute its
dependency closure, no filtered registry, and therefore no F4 artifact for just the public site —
`./equin release --composition website` fails with `Unknown composition "website"`.

This plan adds that composition and proves it end-to-end with a local `--target web --dev` release.
Public hosting (roadmap steps 1–2 and 5 of
[`2026-05-04-global-equin-ai-deployment-roadmap.md`](./2026-05-04-global-equin-ai-deployment-roadmap.md))
stays out of scope.

Writing the manifest surfaced two structural facts that shape it. Both are recorded here because the
manifest vocabulary is **additive only** — `entryPoints` / `selectedContributors` / `extends` can
only add plugins, `excludes` is a check-time assertion, and nothing subtracts. So anything that a
seed would wrongly drag in has to be fixed in the *plugin graph*, not in the manifest.

### 1. `apps.website` is not entry-able as a whole

`expandEntrySeeds` seeds an entry **plus its entire subtree**
(`plugins/plugin-meta/plugins/closure/core/resolve-composition.ts:53`), so
`entryPoints: ["apps.website"]` would seed all 17 sub-plugins — including
`blog/pages-integration`, whose first line is:

```ts
import { PageDetail } from "@plugins/apps/plugins/pages/plugins/page-tree/web";
```

That plugin is the Publish panel mounted into the **Pages app's** detail pane. It exists only for
authoring. Seeding it drags `apps.pages.page-tree`, the block editor, and `Apps.App({id: "pages"})`
into the public bundle.

The blog is on its way out anyway (user decision), so the composition **entries the website's
sub-umbrellas individually and omits the `blog` umbrella entirely**. The blog tree is cleanly
severable: only `blog/site` and `blog/pages-integration` import `blog/publish`, and nothing outside
`blog/` imports any of the three. Dropping the whole umbrella also drops the site's single
server-side plugin, the `page` block-editor closure, and the `blogPostsResource` live-state
resource. The released site loses its "Blog" nav link; the dev app is untouched.

### 2. A playable Sonata vignette drags Sonata's whole app in — and the keyboard is not to blame

`demos/app-gallery`'s Sonata vignette is the one demo that embeds a *real* plugin. The keyboard
itself is a clean leaf: `primitives/keyboard/web` imports only web-sdk and config_v2, and says so —
*"the keyboard primitive stays a leaf — it never imports the app shell."*

The problem is **sound**. The vignette resolves the sampled grand generically, without naming the
piano plugin:

```ts
const instruments = Sonata.Instrument.useContributions();
const defaultInstrument = instruments.find((i) => i.default) ?? instruments[0];
```

`Sonata` is the slot namespace, and it lives in `sonata/plugins/shell/web/slots.ts` — the same barrel
whose default export is `contributions: [Apps.App({ id: "sonata", path: "/sonata" })]`. Two
independent hard edges land on it:

1. the vignette → `shell/web` (for `Sonata.Instrument` and the `InstrumentVoices` type);
2. `audio/piano/web` → `shell/web` — **any** instrument contributor must import the slot owner to
   call `Sonata.Instrument({...})`.

Edge (2) is the load-bearing one: a bundle with a playable instrument *necessarily* registers a
second `Apps.App`. And since `home` (the only app with `default: true`) is absent from a website
bundle, `defaultApp = apps.find(a => a.default) ?? apps[0]`
(`plugins/apps-core/web/internal/resolve-app.ts:34`) falls back to rail order, where `sonata` sorts
before `website` — so bare `/` on the released site would redirect to `/sonata`.

**The fix is to stop co-locating an extension point with an app registration.** The *narrow, correct*
boundary is the Instrument axis alone: it is an audio contract (`createVoices`, `InstrumentVoices`,
`ScheduledNote`), consumable by any host with an `AudioContext`. Sonata's other slot axes
(`Source`, `Display`, `Analyzer`, `Overlay`, `Home`, `Transport`, `Hud`, `Section`, `ViewOption`)
genuinely render inside the Sonata app surface and stay with `shell`.

> **The new plugin's slot file MUST be named `web/slots.ts`.** In `skipBarrelImport` mode — the mode
> the closure engine, the `composition-closure` check, and `build --composition` all use — the slots
> facet falls back to a static text parse of exactly that hardcoded path
> (`plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts`). Any other filename yields an
> empty slots facet in that mode, so `classifyEdges` registers no group owner and every soft edge
> into the plugin silently disappears. It still renders at runtime and still appears in
> `docs/plugins-details.md` (docgen imports barrels), so the only symptom is a remote, misleading
> `composition-closure` failure: *"selects `apps.sonata.audio.piano`, which is not a genuine soft
> option."* Hit during implementation; filed as a task to fix structurally.

Scope check, measured: 89 files under `plugins/apps/plugins/sonata/` import `shell/web`, and 49 of
them import the `Sonata` namespace — but only **12 code files** touch `Sonata.Instrument` /
`InstrumentVoices` / `ScheduledNote`. Splitting the whole namespace would also relocate 12 reorder
config files (`config/apps/sonata/shell/sonata.{home,hud,transport,section,toolbar.*}.jsonc`), since
reorder config paths are keyed by the slot-owning plugin. Splitting only the Instrument axis moves
**no** config: `Instrument` is a headless `defineSlot`, not a `defineRenderSlot`.

## Part 1 — extract the Instrument extension point

New leaf plugin: `plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/`

```
audio/plugins/instruments/
  package.json                  # @singularity/plugin-apps-sonata-audio-instruments
  CLAUDE.md
  web/index.ts                  # barrel: re-exports ./slot, default-exports the plugin def
  web/slot.ts                   # SonataAudio namespace + the voice contracts
```

```ts
// web/slot.ts
export interface ScheduledNote { pitch: number; velocity: number; when: number; duration: number }
export interface InstrumentVoices { loaded: Promise<void>; schedule(n: ScheduledNote): void;
  allOff(): void; dispose(): void; play?(pitch: number, velocity: number): () => void }

export const SonataAudio = {
  Instrument: defineSlot<{ id: string; label: string; icon?: IconType; gmProgram?: number;
    group?: string; default?: boolean;
    createVoices: (ctx: AudioContext, destination: AudioNode) => InstrumentVoices;
  }>("sonata.instrument", { docLabel: (p) => p.label }),
};
```

- **Slot id `"sonata.instrument"` is unchanged**, so no contribution data or docs churn. Only the
  *group symbol* changes (`Sonata.Instrument` → `SonataAudio.Instrument`), which is what re-points
  the soft edge from `sonata.shell` to `sonata.audio.instruments`. Keep it as a namespace object,
  not a bare exported slot: the `slots` facet derives `groupName` from the top-level export key
  (`plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts:115`), and every existing slot in
  the repo uses the namespace shape.
- **Barrel purity**: the slot consts live in `web/slot.ts`; `web/index.ts` only re-exports them and
  default-exports `{ description, contributions: [] }`.
- Do **not** re-export `Sonata.Instrument` from `sonata/shell` — cross-plugin re-exports are banned,
  and the whole point is to cut that edge.

Re-point these 12 code files (one import line each, plus dropping the definitions from `slots.ts`):

| file | uses |
|---|---|
| `sonata/shell/web/slots.ts` | **remove** `Instrument`, `InstrumentVoices`, `ScheduledNote` |
| `sonata/shell/web/index.ts` | drop the `InstrumentVoices` / `ScheduledNote` type re-exports |
| `sonata/audio/piano/web/{index.ts,voices.ts}` | contributes; `InstrumentVoices` |
| `sonata/audio/soundfont/web/{index.ts,gm.ts,voices.ts}` | contributes; `InstrumentVoices` |
| `sonata/audio/engine/web/{components/audio-engine.tsx,scheduler.ts}` | consumes; `ScheduledNote` |
| `sonata/audio/metronome/web/{click-voice.ts,components/metronome-engine.tsx}` | `InstrumentVoices` |
| `sonata/audio/live-play/web/components/live-play-engine.tsx` | consumes |
| `sonata/track-mixer/web/{hooks.ts,components/track-mixer-panel.tsx}` | consumes |
| `website/demos/app-gallery/web/components/vignettes/sonata-vignette.tsx` | consumes |

After the split, `sonata-vignette.tsx` imports `SonataAudio` from the new leaf and `Keyboard` from
`primitives/keyboard/web`. **Neither reaches `sonata/shell`.** The website bundle registers exactly
one `Apps.App`.

Hand-written prose in the affected `CLAUDE.md`s (shell, piano, soundfont, engine, metronome,
live-play, track-mixer, app-gallery) needs a light pass; their autogen blocks regenerate on build.

## Part 2 — the composition seed

`./equin build --composition <name>` resolves the manifest from
`compositionsConfig.fields.manifests.defaultValue` — the **code** seed
(`plugins/framework/plugins/cli/bin/commands/build.ts:844`), not the JSONC. So this is a code edit in
`plugins/plugin-meta/plugins/composition/core/config.ts`; `./equin build` regenerates
`config/plugin-meta/composition/compositions.origin.jsonc`.

The `app()` helper only takes a single umbrella entry, so write the seed as an explicit literal
(precedent: the `agent-manager` and `agent-runtime` seeds), inserted after `workflows` with rank
`"aB5"` (fractional-index precedent: `aJ5`, `aN5`):

```ts
// The public equin site. Deliberately does NOT entry the `apps.website` umbrella:
// entry-seeding ships the whole subtree, and `blog/pages-integration` hard-imports
// the Pages app's page-tree to mount its authoring panel. The blog is omitted
// wholesale — the site's only server plugin and its only `page` dependency.
{
  id: "website",
  rank: "aB5",
  name: "website",
  category: "app" as const,
  entryPoints: [
    "apps.website.shell",      // app entry, panes, layout, Website.* slots
    "apps.website.landing",    // hero / pillars / cta — new sections auto-ship
    "apps.website.pillars",    // agents / apps / platform pages
    "apps.website.downloads",
    // Demos entried individually to omit editor-toy (see below):
    "apps.website.demos.agent-run",
    "apps.website.demos.app-gallery",
    "apps.website.demos.plugin-pyramid",
    "apps.website.demos.release-switcher",
    "apps.website.demos.theme-toy",
  ],
  // The sampled grand behind the gallery's Sonata vignette. A genuine soft option:
  // it contributes SonataAudio.Instrument, whose owner the vignette hard-imports.
  selectedContributors: ["apps.sonata.audio.piano"],
  extends: ["served-baseline"],
  excludes: ["agent-runtime", "auth"],
}
```

Notes on each field:

- **No `app-chrome`.** A public site wants no rail and no tab strip; `apps-core.layout` renders a
  chrome-less surface on its own. Same as the `sonata` composition.
- **`excludes` mirrors the sonata precedent** — `agent-runtime` + `auth`, the infra bundles a
  self-contained public site must ship without. It does **not** exclude `page-editor`: the block
  editor is a legitimate site dependency (the blog/read-only path and, transitively, most content
  UI). The `pages-integration` authoring panel stays out **structurally** — its plugin lives under
  the `blog` umbrella, which this composition never entries — not via a `page-editor` exclude.
- **`editor-toy` is deliberately not bundled** (the demos are entried individually rather than
  entrying the `demos` umbrella). editor-toy embeds a live `<BlockEditor>`, and the editor's hard
  closure reaches worktree infra: `page.editor → reorder → config_v2.staging → infra.worktree`
  (staging lands a promoted config default to git). That drags `infra.worktree` — part of the
  excluded `agent-runtime` bundle — into a site meant to be self-contained. Self-containment is the
  point of this composition, so editor-toy is left out; every other demo ships. Making a live editor
  releasable stand-alone (severing the reorder→staging→worktree taproot) is a follow-up. This
  surfaced only after editor-toy landed on main mid-implementation, which is exactly the guard
  working: the `agent-runtime` exclude caught a real contamination path.
- **Only bundles that don't extend `served-baseline` are excludable.** An earlier draft of this plan
  also listed `pages`, which is a category error: the check compares against the excluded bundle's
  **flattened** containment, and every app composition extends `served-baseline`, so `pages`'
  containment carries `apps-core.layout`, `infra.health`, `shell.toast`, and the token groups that
  `website` legitimately bundles too. `excludes` names *infra* bundles — that is the whole
  vocabulary. (Verified: the check failed on exactly those 13 shared plugins.)
- **Not `excludes: ["sonata"]`** either — the sonata bundle's *containment* is `apps.sonata` +
  subtree, which legitimately includes `instruments`, `keyboard`, and `piano`.

Add a case to `plugins/plugin-meta/plugins/composition/core/config.test.ts` asserting the `website`
seed maps to a valid manifest and that no entry point is under `apps.website.blog`.

## Part 3 — the smoke test

```bash
./equin build                                            # regen origin jsonc + registries + docs
./equin check                                            # composition-closure, boundaries, type-check
./equin release --composition website --target web --dev # stage the F4 artifact
```

Then boot the staged tree on its own data root and verify:

```bash
<out>/launch &                                                 # self-roots SINGULARITY_DIR under <out>/data
bun e2e/release-boot-verify.mjs --url http://website.localhost:9100/ --settle 15000
```

`<out>` is `~/.singularity/releases/<worktree>/website-web/<run-id>/`, also reachable via the
sibling `latest` symlink.

## Verification — results

All executed against staged run `~/.singularity/releases/singularity/website-web/release-1783651403250-ofuj7r`.

1. **Closure is lean.** `./equin build` green (all 56 checks, incl. `composition-closure`).
   `release` reports **108 plugins in closure** (full tree ≈ 540); the filtered web registry has 99
   entries.
2. **Exactly one app.** `web.composition.generated.ts` contains only three Sonata plugins —
   `audio/instruments`, `audio/piano`, `primitives/keyboard` — and **no `sonata/plugins/shell`**.
   Bare `/` settles at `/website` (not `/sonata`). Zero matches for `apps/plugins/agent-manager`,
   `apps/plugins/pages`, `page/plugins/editor`, `conversations`, `tasks`, `auth`.
3. **No blog, no editor.** `/website/blog` renders the not-found pane; no Blog nav link.
4. **The site renders.** `e2e/release-boot-verify.mjs` → `✓ PASS`, 183 `#root` nodes, **0 console
   errors, 0 page errors, 0 4xx/5xx**. Panes verified 200 + content: `/website`, `/website/download`,
   `/website/apps`, `/website/platform`, `/website/agent-manager`.
   (Note: the Agents pillar route is `/website/agent-manager`; "Agents" is only the nav label.)
5. **The Sonata vignette plays inside the release.** Apps pillar → Sonata tab → key press: caption
   goes `"Click or drag across the keys."` → `"This is Sonata's real keyboard plugin and sampled
   piano."`, i.e. the 452-sample grand loaded and sounded. `release` pre-warmed the asset-mirror for
   `splendid-grand-piano`, confirming the instrument is genuinely in the closure.
6. **Dev app unaffected.** `/website/agent-manager` behaves identically in the dev deployment and the
   release; Sonata still plays in the dev app.

Known cosmetic issue (pre-existing, not introduced here): the released page logs three
`net::ERR_ABORTED /api/logs/emit` request failures — `clientLog` flushing on unload. No console or
page errors result.

## Critical files

Create:
- `plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/{package.json,CLAUDE.md,web/index.ts,web/slot.ts}`

Modify:
- `plugins/plugin-meta/plugins/composition/core/config.ts` — the `website` seed (+ `config.test.ts`)
- `plugins/apps/plugins/sonata/plugins/shell/web/{slots.ts,index.ts}` — remove the Instrument axis
- the 10 Sonata/website files listed in Part 1 — re-point one import each
- affected `CLAUDE.md` prose

Regenerated by `./equin build` — never hand-edit:
- `config/plugin-meta/composition/compositions.origin.jsonc`
- `plugins/framework/plugins/web-sdk/core/{web.generated.ts,web-tiers.generated.ts}`,
  `plugins/framework/plugins/server-core/core/server.generated.ts`
- `docs/plugins-{compact,details}.md`

## Follow-ups (file with `add_task`, do not build here)

- **Retire the blog.** It is now outside the release closure; deleting `website/blog/*` (and its
  `page_blocks_ext_blog_post` migration) is a clean, separate change.
- **A `defaultApp` that doesn't depend on rail order.** `apps.find(a => a.default) ?? apps[0]` is
  only correct today because exactly one app sets `default` and filtered bundles happen to contain
  one app. A composition-declared default (or a loud error on zero/multiple defaults) would make
  the black-screen/wrong-app class impossible.
- **Public hosting** — roadmap steps 1–2 (Hetzner + Caddy + gateway `-base-domain`) and 5 (deploy
  pipeline).
