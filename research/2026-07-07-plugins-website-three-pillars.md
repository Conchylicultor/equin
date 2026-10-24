# equin website — restructure around the three pillars

## Context

The equin public site (`plugins/apps/plugins/website/`) currently presents equin as a flat 6-card features grid that mixes three fundamentally different stories. The user wants the site to explicitly display the **three pillars**, which reinforce/demonstrate each other but target different audiences:

1. **The apps** (Pages, Mail, Sonata, Workflows, …) — what end-users care about.
2. **The agent manager** — the agents that build the apps and plugins.
3. **The core plugin architecture** — the foundation underneath. An internal detail most end-users shouldn't care about → pitched to developers as a "behind the scenes" story, showing the **plugins → apps → release pyramid**.

User decisions (fixed):
- **Structure**: landing gets a three-pillars teaser band; each pillar gets a dedicated pane (`/website/apps`, `/website/agents`, `/website/platform`); nav gains links.
- **Platform tone**: developer/geek-targeted, behind-the-scenes, pyramid front and center.
- **Release-targets demo** (same app ships as standalone Tauri / standalone web / window inside the equin desktop): a **landing band** — the proof the pillars reinforce each other; pillar pages link to it.
- **Demo depth: interactive everywhere.** Every pillar page gets a live toy (theme-toy is the gold standard); the release band is itself an interactive switcher.

## Target information architecture

Nav: `equin | Apps  Agents  Platform  Blog  [Download]` (Download stays the single primary CTA, rightmost).

| Route | Pane id | Owner plugin |
|---|---|---|
| `/website` | `website-landing` (existing) | `shell` (unchanged) |
| `/website/apps` | `website-apps` | `pillars/apps` (new) |
| `/website/agents` | `website-agents` | `pillars/agents` (new) |
| `/website/platform` | `website-platform` | `pillars/platform` (new) |
| `/website/download`, `/website/blog`, `/website/blog/:slug` | existing | unchanged |

Landing band order: **hero → pillars teaser → release-targets switcher → CTA**.

- The 6-card **features band is deleted** (`landing/plugins/features/`); its copy redistributes: Pages/Mail/Workflows (+ new Sonata card) → Apps page; Agent manager → Agents page; Theming + Plugin architecture → Platform page.
- **theme-toy moves off the landing onto the Platform page** (reframed "Theming is a plugin too — try it."): the landing keeps one load-bearing interactive band (release switcher), and theming-as-a-plugin is exactly the platform story.

## Plugin tree (new/changed)

```
plugins/apps/plugins/website/plugins/
├── shell/                          unchanged
├── landing/plugins/
│   ├── hero/                       unchanged
│   ├── features/                   DELETE (copy redistributed)
│   ├── pillars/                    NEW — three-pillar teaser band (Website.Section)
│   └── cta/                        unchanged
├── pillars/                        NEW umbrella (package.json only, like landing/)
│   └── plugins/
│       ├── apps/                   NEW — pane + WebsiteApps.Section slot + nav + content bands
│       ├── agents/                 NEW — pane + WebsiteAgents.Section slot + nav + content bands
│       └── platform/               NEW — pane + WebsitePlatform.Section slot + nav + content bands
├── demos/plugins/
│   ├── theme-toy/                  MODIFY — retarget to WebsitePlatform.Section; import SampleVignette
│   ├── sample-app/                 NEW — shared SampleVignette (promoted out of theme-toy)
│   ├── release-switcher/           NEW — landing band + core/ release-target closed list
│   ├── app-gallery/                NEW — Apps demo (WebsiteApps.Section)
│   ├── agent-run/                  NEW — Agents demo (WebsiteAgents.Section)
│   └── plugin-pyramid/             NEW — Platform demo (WebsitePlatform.Section)
├── downloads/                      unchanged
└── blog/                           unchanged
```

### Architecture decisions

- **Per-pillar Section slots — yes.** Each pillar plugin defines its own render slot in `web/slots.ts` mirroring `shell/web/slots.ts`: `WebsiteApps.Section` (`"website.apps.section"`), `WebsiteAgents.Section` (`"website.agents.section"`), `WebsitePlatform.Section` (`"website.platform.section"`). Required by collection-consumer separation: the demos live under the `demos/` umbrella (existing precedent — theme-toy contributes into a shell-owned slot), so each pillar page has an external contributor and must not name it.
- **No fractal sub-plugin split for pillar copy.** Each pillar plugin contributes its own hero/showcase/closing bands from `web/components/` into its own slot (precedent: shell contributes its own `WebsiteWordmark` into its own `WebsiteToolbar.Start`). Named reason for deviating from the landing's one-band-one-plugin shape: pillar copy is closed single-owner content; the slot exists for cross-plugin contributors (demos, future bands), not to shard one page's prose. Three plugins instead of ~twelve.
- **`SampleVignette` promoted, not duplicated.** New `demos/plugins/sample-app/` with a web barrel exporting `SampleVignette` (moved verbatim from `theme-toy/web/components/theme-toy.tsx`). theme-toy + release-switcher import it via the barrel — respects barrel purity and no-cross-plugin-re-exports.
- **Closed lists → `core/`.** Release targets in `release-switcher/core/targets.ts` (mirrors `downloads/core/downloads.ts`): `type ReleaseTargetId = "desktop" | "web" | "workspace"`, `RELEASE_TARGETS: readonly { id, label, tagline }[]`. `plugin-pyramid` imports it for its top tier — one source of truth tying the two demos. Purely presentational per-component arrays stay local consts (precedent: `FEATURES` in features-section.tsx).
- **Zero server code.** All demos are client-only state + finite user-triggered timers/WebAudio with cleanup (no polling).
- **No import cycles**: landing/pillars band imports pillar panes (consumer-side, same as cta → downloadsPane); pillar plugins import only shell/downloads; demos import pillar slots + sample-app; release-switcher/core ← plugin-pyramid is one-directional.

### Per-pillar plugin layout (Apps shown; Agents/Platform identical shape)

```
pillars/plugins/apps/
├── package.json                 # @singularity/plugin-... (mirror sibling naming)
├── web/
│   ├── index.ts                 # exports appsPane + WebsiteApps; registers pane, nav, own bands
│   ├── slots.ts                 # WebsiteApps.Section          [precedent: shell/web/slots.ts]
│   ├── panes.tsx                # appsPane, segment "apps", chrome.header: WebsiteToolbar,
│   │                            #   body <WebsitePage><WebsiteApps.Section.Render/></WebsitePage>
│   │                            #                              [precedent: downloads/web/panes.tsx]
│   └── components/
│       ├── apps-nav-item.tsx    # WebsiteNavLink "Apps" → openPane(appsPane, {}, {mode:"root"})
│       │                        #                              [precedent: blog-nav-item.tsx]
│       ├── apps-hero.tsx        #                              [precedent: hero-section.tsx]
│       ├── apps-showcase.tsx    # cards band, local array      [precedent: features-section.tsx]
│       └── apps-closing.tsx     # cross-links + Download       [precedent: cta-section.tsx]
```

## Page content (headline-level)

- **Landing pillars band** (`landing/plugins/pillars/web/components/pillars-section.tsx`): eyebrow "Three pillars", h2 "Apps you use. Agents that build them. A platform underneath." Grid of three Cards (icon, title, blurb, 3-item highlight list, "Explore →" ghost Button → pillar pane). Hardcoded three cards — the pillar set is closed by definition, not a slot.
- **/website/apps** (end-user tone): hero "Real apps, ready on day one." → showcase cards (Pages, Mail, Sonata, Workflows) → app-gallery demo band → closing "Every app here ships three ways." (link to landing) + Download.
- **/website/agents**: hero "A workforce that builds your workspace." → how-it-works cards (Nested tasks / Isolated worktrees / The race) → agent-run demo band → closing link to Apps + Download.
- **/website/platform** (developer tone): hero eyebrow "Behind the scenes", h1 "Everything is a plugin." → plugin-pyramid demo band → theme-toy band (retargeted) → closing "See a release happen →" (landing) + Download.

Cross-links use `useOpenPane` + `mode: "root"`. Scroll-to-band deep anchoring on the landing = polish follow-up, out of scope.

## Interactive demos (all client-only; section scaffold copied from theme-toy.tsx: eyebrow + heading + muted body + centered demo)

### Release-targets switcher (landing) — `demos/plugins/release-switcher/`
- Copy: eyebrow "One release engine", h2 "Build once. Ship three ways."
- `SegmentedControl` over `RELEASE_TARGETS`; `TargetFrame({ target, children })` renders **one persistent `<SampleVignette/>`** inside target-specific chrome (`transition-all duration-300` so switching reads as re-hosting the same app):
  - **desktop** (Tauri): rounded window + traffic-light dots + title-bar caption "Aurora — equin native"
  - **web**: browser tab strip + address-bar Surface row (`MdLock` + `aurora.equin.app`)
  - **workspace**: mini equin desktop — left icon rail (one active), top tab-bar hint, vignette floating as an inner window
- Ghost links below: "Explore the apps" → appsPane, "How the platform works" → platformPane.

### App gallery (Apps page) — `demos/plugins/app-gallery/`
- h2 "Four apps, one surface."; `SegmentedControl` [Pages, Mail, Sonata, Workflows] selecting one genuinely interactive vignette:
  - **Pages**: mini doc with working todo checkboxes (`useState<Set>` + line-through)
  - **Mail**: 4 inbox rows; click selects, clears unread dot, swaps a one-line reading pane
  - **Sonata — REAL embed, not a toy** (user decision): mount the real `Keyboard` primitive from `@plugins/apps/plugins/sonata/plugins/primitives/plugins/keyboard/web` (pure props: `low`/`high`/`lit`/`interaction: { onPress, onRelease }`; multi-touch/glissando built in). Real sound via the sanctioned collection API: `Sonata.Instrument.useContributions()` (from `@plugins/apps/plugins/sonata/plugins/shell/web`) → pick the `default: true` piano entry → `createVoices(ownAudioContext, ownGainNode)` on first press (user gesture ⇒ autoplay OK) → `voices.play(pitch, velocity)`; `voices.dispose()` on unmount. This bypasses `SonataProvider`/`AudioEngine`/`LivePlayEngine` entirely — **no DB write is reachable** (all Sonata persistence keys off `currentSongId` state we never mount), so "restricted mode" is structural, not stubbed. Handle two async states: Sonata's audio/keyboard plugins are in the deferred load tier (`useContributions()` empty for a beat after boot) and samples stream lazily from `/api/asset-mirror/splendid-grand-piano/...` — show a "warming up" state until the contribution appears and `voices.loaded` resolves. Precedent for cross-app embed of real components: `blog/site/web/components/blog-post.tsx` renders Pages' real `ReadOnlyBlocks`. Do NOT deep-import `voices.ts` (not exported; boundary check fails) and do NOT reuse `PianoKeyboard` (requires `SonataProvider` + piano-roll projection).
  - **Workflows**: Trigger → Prompt → Send step chips + Run; chained `setTimeout`s (ids in ref, cleared on unmount) advance muted → running (bouncing-dots) → success Badge
- Band copy: Pages/Mail/Workflows framed as "toy replicas — the real ones live in equin"; the Sonata card framed as the platform proof: "this is the real Sonata keyboard plugin and the real sampled piano, embedded." Follow-up (out of scope): give Pages the same real-embed treatment via `ReadOnlyBlocks`.

### Agent-run simulator (Agents page) — `demos/plugins/agent-run/`
- h2 "Launch an agent. Watch it merge."; local `STAGES` (worktree 900ms → edit 1400ms → build 1100ms → merge 700ms, each with a fake log caption) and `TASKS` (3 fake tasks, one with subtasks that check off).
- Per-task state `{ status, stage }`; chained `setTimeout`s in a ref with unmount cleanup; concurrent launches allowed so tasks visibly "race". Timeline of stage chips (muted Badge → info Badge + bouncing-dots → success check), completion = line-through + "Merged" Badge, header counter "2 / 3 tasks closed", ghost Reset.

### Pyramid composer (Platform page) — `demos/plugins/plugin-pyramid/`
- h2 "Plugins compose apps. Apps compose releases." Three stacked tiers with decreasing max-widths (base `max-w-3xl` → `max-w-xl` → `max-w-sm`) so the silhouette *is* the pyramid, chevron connectors upward:
  - **Base — plugins**: four `ToggleChip`s (Editor, Charts, Tags, Actions), all on
  - **Middle — the app**: `composed-vignette.tsx`, a mini app Card whose four regions map 1:1 to the chips; toggling off collapses the region into a **dashed "empty slot" placeholder labeled with the slot name** (opacity/height transition) — the app is literally the sum of its plugins
  - **Top — the release**: three chips from `RELEASE_TARGETS` + "the same composition ships to all three" + ghost link to the landing release band
- State: `useState<Set<PluginBlockId>>`; pure CSS transitions.

### theme-toy changes
`web/index.ts`: retarget contribution `Website.Section` → `WebsitePlatform.Section`. `theme-toy.tsx`: delete local `SampleVignette`/`CHART_BARS`, import from sample-app; reframe copy to the platform story.

## Reorder configs to author (after `./equin build` regenerates origins; procedure in `plugins/reorder/authoring-overrides.md`)

| File | Action |
|---|---|
| `config/apps/website/shell/website.section.jsonc` | items → hero, pillars, release-switcher, cta; re-stamp `@hash` |
| `config/apps/website/shell/website.toolbar.end.jsonc` | items → apps, agents, platform, blog, download; re-stamp `@hash` |
| `config/apps/website/pillars/apps/website.apps.section.jsonc` | NEW — hero, showcase, app-gallery, closing |
| `config/apps/website/pillars/agents/website.agents.section.jsonc` | NEW — hero, how-it-works, agent-run, closing |
| `config/apps/website/pillars/platform/website.platform.section.jsonc` | NEW — hero, plugin-pyramid, theme-toy, closing |

Deleting `landing/plugins/features/` shifts the section origin hash — build + config reconcile is mandatory (enforced by `reorder:configs-authored` / `config-origins-in-sync`).

## Phasing

1. **Pillar scaffolding** (M-L): `pillars/` umbrella + 3 pillar plugins (panes, slots, nav, static bands) + `release-switcher/core/targets.ts` landed early to unblock parallelism + config reconciles. Build → 5 nav links, 3 static pages.
2. **Landing rework** (S-M): pillars band, delete features/, reconcile `website.section.jsonc`.
3. **sample-app extraction + theme-toy retarget** (S).
4. **release-switcher band** (M, after 3).
5. **app-gallery** (M-L) — parallel with 4/6/7.
6. **agent-run** (M) — parallel.
7. **plugin-pyramid** (M-L) — parallel (core/targets.ts already landed in 1).
8. **Polish pass** (per `sidequests/ui-mastery`): typography/motion/responsive; optional landing-anchor deep links.

## Verification

Per phase:
1. `./equin build`, then `./equin check` (registry sync, boundaries, `reorder:configs-authored`, `config-origins-in-sync`, lints).
2. Scripted Playwright per `e2e/screenshot.mjs` (give every demo control a stable `aria-label`; before/after pairs):
   - Nav: landing → click "Agents" → agents pane renders; browser back returns.
   - Release switcher: click "Web app" segment → tab-strip/address-bar chrome appears.
   - App gallery: click "Sonata" → piano renders; click a key → `aria-pressed`/state class (audio itself unassertable).
   - Agent run: click "Launch agent", wait past ~4s → "Merged" badge + counter increment.
   - Pyramid: toggle "Charts" off → dashed empty-slot placeholder where the chart was.
   - theme-toy restyles only its scope, now on `/website/platform`.
3. Manual sweep: all six routes render header+footer exactly once; Download rightmost primary; landing shows exactly four bands.

## Critical files

- `plugins/apps/plugins/website/plugins/shell/web/slots.ts` — slot/toolbar pattern every pillar mirrors (+ `panes.tsx`, `index.ts` beside it)
- `plugins/apps/plugins/website/plugins/downloads/web/panes.tsx` — byte-for-byte pane precedent (+ `download-nav-item.tsx` for nav)
- `plugins/apps/plugins/website/plugins/demos/plugins/theme-toy/web/components/theme-toy.tsx` — interactivity gold standard; source of promoted `SampleVignette`; section scaffold for all demos
- `plugins/apps/plugins/website/plugins/landing/plugins/features/web/components/features-section.tsx` — band being replaced; `FEATURES` copy redistributes
- `config/apps/website/shell/website.section.jsonc` + `website.toolbar.end.jsonc` — reorder-config mechanism to reconcile
