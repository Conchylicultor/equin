import { defineConfig } from "@plugins/config_v2/core";
import { listField } from "@plugins/fields/plugins/list/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { enumField } from "@plugins/fields/plugins/enum/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import {
  BASE_EXCLUSIONS_ID,
  MAIN_COMPOSITION_ID,
} from "@plugins/infra/plugins/namespace/core";
import { SERVE_MODE_OPTIONS } from "./serve-mode";

// The composition manifest registry — plain editable data in config_v2 (no
// codegen, no barrels). Each item is a `CompositionManifest`
// (`{ name, entryPoints, selectedContributors, extends }`, owned by `closure`)
// plus a `category` (organisation metadata, NOT consumed by the engine) and the
// list field's `id` identity. Runtime-editable from the Studio compositions
// pane, where an edit lands in the per-worktree USER layer; the committed
// default is these code seeds, changed by editing this file and pushing.
//
// ── Categories (the taxonomy the seeds populate) ──────────────────────────────
//   app        — one per top-level Apps.App: the releasable products. Entry is the
//                app shell umbrella; an empty contributor list is the lean baseline.
//   profile    — a variant of ONE app along the self-improvement axis (the worked
//                example is agent-manager full vs. lean).
//   subsystem  — an infra closure used as a building block / inspection lens, never
//                released alone (data, jobs-events, live-state, auth, …).
//   pack       — a reusable, entry-less contributor SET that apps opt into via
//                `extends` (first-class composition reference; resolved by
//                `flattenManifest` before closure). `self-improvement` is the pack
//                the agent-manager profile demonstrates.
//
// Code defaults carry an EXPLICIT stable `id` (the UI only auto-injects one on
// "Add"), so seeded rows are editable. Order is array position — no `rank`.
export const compositionsConfig = defineConfig({
  name: "compositions",
  fields: {
    manifests: listField({
      label: "Compositions",
      // Item ids are durable keys: the Studio detail pane routes on `comp/:id`.
      stableIdentity: true,
      itemFields: {
        name: textField({ label: "Name" }),
        category: enumField({
          label: "Category",
          options: ["app", "profile", "subsystem", "pack"],
          default: "app",
        }),
        entryPoints: stringListField({ label: "Entry points" }),
        selectedContributors: stringListField({ label: "Contributors" }),
        extends: stringListField({ label: "Extends" }),
        // The dual of `extends`: bundle NAMES this composition's hard closure must
        // stay DISJOINT from. Engine-opaque metadata (NOT a `CompositionManifest`
        // field — resolution stays additive-only); the `composition-closure` check
        // enforces disjointness against each named bundle's containment. Lets an
        // app declare it is self-contained (e.g. excludes `agent-runtime`/`auth`).
        excludes: stringListField({ label: "Excludes" }),
        // WHEN this composition should be built and served. Anything but `off`
        // declares "this composition is meant to be live here" — a build of it
        // composes a per-composition frontend dist + empty DB served at
        // http://<id>.<checkout>.localhost:9000. Still intent, not liveness:
        // what is actually served is what the composition.json marker says.
        //
        // The mode is BOTH halves of the intent — that it is served at all, and
        // for the automatic modes the rate limit at which the build convergence
        // loop may rebuild it (`autoRebuildIntervalMs`, core/serve-mode.ts).
        // One enum rather than a flag plus a mode, so "rebuild on push but not
        // served" has no spelling. An explicit rebuild stays available in every
        // mode.
        //
        // Main's row can never be served: `singularity` is a reserved namespace
        // belonging to the checkout's own build, and `activatedCompositionIds`
        // filters on servability — so a stored non-`off` on that row is inert by
        // construction, from any config layer.
        //
        // Engine-opaque — like `category` / `excludes`, `manifestItemToManifest`
        // DROPS it (the closure engine never sees it).
        serve: enumField({
          label: "Serve",
          options: [...SERVE_MODE_OPTIONS],
          default: "off",
        }),
      },
      default: [
        // ── The main app ────────────────────────────────────────────────────────
        // The app this repo builds is an ORDINARY entry in this registry, not a
        // special case the closure engine has to know about. Every rule that holds
        // for a composition now holds for main too, with no "except for main"
        // clause — and `plugins-registry-in-sync` proves it mechanically: this
        // composition's resolved closure must render the committed
        // `<dir>.generated.ts` registries byte-for-byte.
        //
        // `entryPoints: ["**"]` is the ROOT pattern — "every plugin". It seeds
        // every node and NAMES none, which is the load-bearing half: `named` is the
        // protected set the negative pass refuses to trim, so a future
        // `"!apps.sonata.**"` beside the `**` can still remove a branch. (If root
        // named everything, every negative would be a self-cancelling no-op and
        // `composition-closure` would reject it as contradictory.) That is exactly
        // the spelling Phase 7 needs to replace the `singularity.disabled`
        // package.json flags with composition negatives.
        //
        // `extends: []` is deliberate, NOT `["served-baseline"]`. `**` already
        // covers everything served-baseline forces in, and extending it would push
        // served-baseline's bases into `named` — permanently shielding them from
        // any future negative, for no gain.
        //
        // Main is not servable as a composition: `singularity` is a reserved
        // namespace that belongs to the checkout's own `./singularity build`, and
        // `activatedCompositionIds` filters on servability, so `serve` on THIS
        // row is inert by construction — a stored mode from any config layer can
        // never name a namespace to provision. `composition-closure` still pins it
        // to `"off"` here so the seed says what is true.
        {
          id: MAIN_COMPOSITION_ID,
          name: MAIN_COMPOSITION_ID,
          category: "app" as const,
          entryPoints: ["**"],
          selectedContributors: [] as string[],
          extends: [] as string[],
          excludes: [] as string[],
          serve: "off",
        },

        // ── The global exclusions ───────────────────────────────────────────────
        // The one row that says what is NOT in any app. Everything else in this
        // registry says what it includes; this one subtracts, and every other row
        // inherits it — `flattenManifest` folds this row into EVERY manifest
        // unconditionally, NOT via `extends`. That difference is the whole point:
        // an exclusion written once holds for compositions that do not exist yet,
        // instead of holding only for the rows whose author remembered to
        // reference it.
        //
        // NEGATIVES ONLY. `selectedContributors` stays empty and every entry point
        // starts with `!` (`composition-closure` enforces both). A positive here
        // would be a way to silently force a plugin INTO every composition, which
        // is `served-baseline`'s job — done through `extends`, where it is visible
        // on the row that opted in.
        //
        // A composition takes a plugin back by NAMING it — as an entry positive or
        // a selected contributor — and the engine's protection rule makes that
        // local positive win over the inherited negative. Naming an *importer* of
        // an excluded plugin is not an opt-out: the importer survives, drags the
        // plugin back through its hard closure, and `unsatisfiedExclusions` reports
        // it rather than guessing which of the two the author meant.
        //
        // `!review.plugin-changes.**` is the migration of the
        // `singularity.disabled: true` flag that used to live in
        // `plugins/review/plugins/plugin-changes/package.json`. That plugin's
        // review-pane summary subscribed to `review.plugin-changes`, firing the
        // worktree-vs-main diff on every render. The negative resolves to the same
        // twelve plugins the flag's closure did — the plugin, its two sub-plugins,
        // and the nine `plugin-meta.facets.<f>.render-diff` adapters that import it
        // — because a negative cascades to descendants and transitive importers
        // exactly as the disabled closure did. One mechanism decides membership now,
        // and it is this one.
        {
          id: BASE_EXCLUSIONS_ID,
          name: BASE_EXCLUSIONS_ID,
          category: "pack" as const,
          entryPoints: ["!review.plugin-changes.**"],
          selectedContributors: [] as string[],
          extends: [] as string[],
          excludes: [] as string[],
          serve: "off",
        },

        // ── Profiles: the agent-manager worked example (full vs. lean) ──────────
        // Full = lean + the self-improvement PACK (first-class `extends`, replacing
        // the formerly-inlined ids). full \ lean is still exactly the pack's set —
        // now sourced through the reference rather than duplicated here.
        {
          id: "agent-manager",
          name: "agent-manager",
          category: "profile",
          entryPoints: ["apps.agent-manager.**"],
          selectedContributors: ["tasks.attempt-view", "ui.theme-toggle"],
          extends: ["self-improvement", "served-baseline"],
          excludes: [] as string[],
          serve: "off",
        },
        {
          id: "agent-manager-lean",
          name: "agent-manager-lean",
          category: "profile",
          entryPoints: ["apps.agent-manager.**"],
          selectedContributors: ["tasks.attempt-view", "ui.theme-toggle"],
          extends: ["served-baseline"],
          excludes: [] as string[],
          serve: "off",
        },

        // ── Apps: lean baseline (entry only) for every other top-level app ──────
        app("home", "apps.home"),
        app("pages", "apps.pages"),
        app("settings", "apps.settings"),
        app("studio", "apps.studio"),
        // The linchpin edge is now CUT: infra.health no longer hard-imports
        // reports (its wedge watchdog emits onto a neutral report-sink that
        // reports.crash registers into), so served-baseline no longer drags
        // reports/tasks/build/git-watcher into every served app's hard closure.
        // Sonata is the worked proof — it `excludes` both the `agent-runtime`
        // bundle and `auth`, and the composition-closure check enforces the
        // disjointness. Rolling the same excludes out to the other served apps is
        // a follow-up. The guard mechanism is live; see
        // plugins/.../checks/.../composition-closure.
        //
        // Its one negative: the MIDI file preview is Sonata's adapter INTO the
        // file viewer, which a standalone Sonata has no host for — and the file
        // viewer reads checkout files through code-api, which drags the
        // agent-runtime bundle in. Likewise transcription launches an agent
        // (a scratch-workspace conversation), which a standalone Sonata has no
        // runtime for.
        {
          ...app(
            "sonata",
            "apps.sonata",
            ["data-views"],
            ["agent-runtime", "auth"],
          ),
          entryPoints: [
            "apps.sonata.**",
            "!apps.sonata.sources.midi.file-preview.**",
            "!apps.sonata.transcription.**",
          ],
        },
        app("debug", "apps.debug"),
        app("deploy", "apps.deploy"),
        app("file-explorer", "apps.file-explorer"),

        // The public equin site: the whole `apps.website` subtree
        // (`"apps.website.**"` seeds the `apps.website` node + its ENTIRE
        // subtree), and nothing subtracted from it — the site is two pages and
        // a homepage, with no branch that reaches outside itself.
        //
        // It used to carry a negative, `"!apps.website.demos.editor-toy.**"`,
        // dropping the one demo whose live `<BlockEditor>` reached worktree
        // infra through `page.editor → reorder → config_v2.staging →
        // infra.worktree`. Both halves are gone: that taproot was severed when
        // `config_v2/staging` was deleted, and the demos themselves were
        // removed with the three-pillar site. If a future site page embeds a
        // live editor again, `excludes: ["agent-runtime"]` below is the
        // AUTOMATED PROOF that it stayed self-contained — it fails if any
        // `→ infra.worktree` taproot survives into the site's hard closure.
        // Never assume that here; run the check.
        //
        // No `app-chrome`: a public site wants no rail and no tab strip
        // (`apps-core.layout` renders a chrome-less surface on its own — same as
        // the `sonata` composition). `excludes` mirrors the sonata precedent
        // (`agent-runtime`, `auth`) — the infra bundles a self-contained public
        // site must ship without.
        //
        // Only bundles that do NOT extend `served-baseline` are excludable. The
        // check compares against the excluded bundle's FLATTENED containment, so
        // excluding an app composition (`pages`, `home`, …) can never pass: its
        // containment always carries the shared baseline (`apps-core.layout`,
        // `infra.health`, `shell.toast`, the token groups) that every app extends.
        // `excludes` names infra bundles — that is the whole vocabulary.
        app("website", "apps.website", [], ["agent-runtime", "auth"]),

        // ── Subsystems: infra closures as building blocks / inspection lenses ───
        subsystem("data", ["database"]),
        subsystem("jobs-events", [
          "infra.jobs",
          "infra.events",
          "infra.secrets",
        ]),
        subsystem("live-state", [
          "primitives.live-state",
          "primitives.networking",
        ]),
        subsystem("auth", ["auth"]),
        subsystem("search", ["search.engine"]),
        subsystem("history", ["history.engine"]),
        subsystem("conversations", ["conversations"]),
        subsystem("tasks-domain", ["tasks"]),
        // The agent-runtime infra closure: what a self-contained app must NOT
        // bundle. Reuses the conversations/tasks-domain subsystems via `extends`
        // and adds the deep taproots (worktree / git-watcher / claude-cli) plus
        // the agent-manager app shell. Apps exclude THIS bundle to assert
        // self-containment. `auth` is a SEPARATE bundle (excluded on demand), not
        // folded in here. Listing the taproots as entries is what lets the check
        // catch transitive contamination: an app's hard closure surfaces any
        // taproot it reaches, where it intersects this bundle's containment.
        {
          id: "agent-runtime",
          name: "agent-runtime",
          category: "subsystem" as const,
          entryPoints: [
            "infra.worktree.**",
            "infra.git.git-watcher.**",
            "infra.claude-cli.**",
            "apps.agent-manager.**",
          ],
          selectedContributors: [] as string[],
          extends: ["conversations", "tasks-domain"],
          excludes: [] as string[],
          serve: "off",
        },
        subsystem("page-editor", ["page"]),
        subsystem("fields", ["fields"]),
        subsystem("design-system", ["primitives.css"]),
        subsystem("mcp", ["infra.mcp"]),
        // The reusable baseline EVERY gateway-served app composition `extends`:
        // the mandatory Core.Root app SURFACE renderer (apps-core.layout —
        // AppsLayout: the tab bar / rail / tab surface; without it a filtered app
        // boots to a black screen, since it's a graph dead-end nothing hard-imports
        // and so its Core.Root contribution silently vanishes — same "force it in"
        // rationale as the toast host below), the liveness/readiness endpoint the
        // gateway probes, the toast HOST (forced alongside health, whose Core.Root
        // watchers dispatch toasts — without the host mounted those toasts would
        // silently vanish), plus the runtime theme engine and the token groups that
        // supply the base CSS variables (without these a filtered app boots
        // unstyled and fails /api/health), and the REORDER layer that applies each
        // slot's committed layout (same dead-end shape again: reorder contributes
        // middleware INTO slot-render, which never imports it back, so a soft-only
        // reorder is left out of every bundle — and its absence does not remove a
        // feature, it silently re-renders every slot in raw registration order and
        // drops the authored `config/**/<slot>.jsonc` layouts; equin.ai shipped
        // that way). Whole `reorder.**` subtree so the node-type renderers come
        // too — a layout naming a spacer or a header group needs them to render.
        // The cost is ~6 plugins on a lean app. It used to be ~41: reorder's list
        // middleware hard-imported `config_v2/staging` to stage "everyone scope"
        // edits, and that edge dragged `database`, `infra.jobs` and
        // `infra.worktree` (staging landed a promoted default by spinning a
        // worktree and pushing) into every served bundle — which is what made
        // adding reorder here fail `composition-closure` against the
        // `agent-runtime` exclusion. Staging is now deleted, so the taproot is
        // gone. What remains is reorder's own DnD editing machinery
        // (`reorder.editor`, `primitives.sortable-list`, dnd-kit): the list
        // middleware both APPLIES a layout and hosts the drag surface, so a
        // released app cannot take one without the other. Splitting those two
        // layers is the filed follow-up.
        // Entry points (not contributors) so they're forced into the hard closure
        // unconditionally; the theme-customizer UI stays opt-in/soft.
        subsystem("served-baseline", [
          "apps-core.layout",
          "infra.health",
          "shell.toast",
          "reorder",
          "ui.theme-engine",
          "ui.tokens.color-palette",
          "ui.tokens.density",
          "ui.tokens.shape",
          "ui.tokens.type-scale",
          "ui.tokens.font-family",
          "ui.tokens.sidebar-palette",
          "ui.tokens.shadow",
          // `--chart-*`: a theme's chart fragment paints nothing unless this
          // group is registered, and `ui.tokens.chart/core` (all a theme imports
          // to spell those values) does not pull in the web half that registers
          // it. equin.ai shipped that way — the hero's wash, its headline
          // gradient and the developers' dot all read `--chart-1`.
          "ui.tokens.chart",
          // The app's own rubber-band, installed from Core.Root and imported by
          // nobody — the same dead-end shape as the toast host and reorder. Left
          // out, a served app falls back to the browser's native bounce, which
          // pulls the whole document off the top and shows the `html` loading
          // floor (`Canvas`, near-black) above the page instead of the page's
          // own top edge. equin.ai shipped that way.
          "primitives.dom.overscroll-hint",
          // Icons: `<Icon>` draws `<use href>` into a sprite sheet that
          // `ui.icons.sprites` mounts, and `ui.tokens.icons` publishes each
          // scope's icon style. Both are wired into `ui.icons`, never imported
          // by it, so a bundle that draws icons does not pull them in: without
          // them every icon renders as an empty box. equin.ai shipped that way —
          // the header's Improve sparkle was blank.
          "ui.icons.sprites",
          "ui.tokens.icons",
        ]),

        // ── Packs: reusable contributor sets apps opt into via `extends` ────────
        pack("self-improvement", [
          "improve.element-picker",
          "review",
          "reports.crash",
          "reports.launch-fix",
          "screenshot.draw-on-app",
        ]),
        pack("theming", [
          "ui.theme-toggle",
          "ui.tweakcn",
          "ui.tweakcn.community-browser",
        ]),
        // The app-surface CHROME, opt-in and extended by nothing: the tab strip,
        // the app rail (its default `rail` variant), and the multi-placement
        // surface (docked / floating / solo). `apps-core.layout` (in
        // served-baseline) renders a chrome-less surface — tabs + tab-surface
        // substrate only — so a composition ships the tab bar / rail / placements
        // only by `extends`-ing this pack (or selecting individual contributors).
        pack("app-chrome", [
          "apps-core.tab-bar",
          "apps-core.app-rail-framing",
          "apps-core.app-rail-framing.rail",
          "apps-core.surface",
          "apps-core.surface.docked",
          "apps-core.surface.floating",
          "apps-core.surface.solo",
        ]),
        // The DataView RENDERING ecosystem: the four view-type renderers plus the
        // per-field-type cell (`DataViewSlots.Cell`) and inline-editor
        // (`DataViewSlots.CellEditor`) contributors. All are `DataViewSlots.*`
        // contributions to `data-view` — graph dead-ends nothing hard-imports (same
        // "force it in" rationale as the toast host / app-chrome). Without them a
        // released DataView has ZERO registered view types, so `buildInstanceFromRow`
        // fail-soft-skips every config-authored view row and the surface renders
        // "No views configured" even though the config value ships. Any app hosting
        // a `<DataView>` `extends` this pack. (Config-authored views live in
        // config_v2; this pack makes the RENDERERS available — the two are
        // orthogonal.)
        //
        // Plus the Filter-pill (`DataViewSlots.Filter`), typed value-codec
        // (`DataViewSlots.ValueCodec`), and enum column-config
        // (`DataViewSlots.ColumnConfig`) contributors. These are now selectable
        // after the static-parser fix (the closure parser used to drop any
        // contribution whose argument was a pre-built const rather than an inline
        // object literal, so `composition-closure` rejected them as "not a genuine
        // soft option"). Carrying them here keeps a released DataView's filtering
        // and typed codecs working instead of fail-soft degrading to identity.
        pack("data-views", [
          "primitives.data-view.gallery",
          "primitives.data-view.table",
          "primitives.data-view.list",
          "primitives.data-view.tree",
          "fields.bool.table",
          "fields.color.table",
          "fields.date.table",
          "fields.enum.table",
          "fields.image.table",
          "fields.number.table",
          "fields.tags.table",
          "fields.text.table",
          "fields.bool.inline",
          "fields.date.inline",
          "fields.enum.inline",
          "fields.number.inline",
          "fields.tags.inline",
          "fields.text.inline",
          "fields.bool.filter",
          "fields.date.filter",
          "fields.enum.filter",
          "fields.number.filter",
          "fields.tags.filter",
          "fields.text.filter",
          "fields.bool.data-view-codec",
          "fields.date.data-view-codec",
          "fields.number.data-view-codec",
          "fields.enum.column-config",
        ]),
      ],
    }),
  },
});

/**
 * A lean app baseline: entry = the app shell umbrella, nothing soft opted in.
 * Every app is a self-contained, gateway-served composition, so it `extends`
 * `served-baseline` by default — the liveness/readiness endpoint the gateway
 * probes plus the base theme/token groups. `extraExtends` adds further packs.
 */
function app(
  name: string,
  entry: string,
  extraExtends: string[] = [],
  excludes: string[] = [],
) {
  return {
    id: name,
    name,
    category: "app" as const,
    entryPoints: [entry + ".**"],
    selectedContributors: [] as string[],
    extends: ["served-baseline", ...extraExtends],
    excludes,
    serve: "off",
  };
}

/** A subsystem closure: one or more infra umbrellas/plugins as entry points. */
function subsystem(name: string, entries: string[]) {
  return {
    id: name,
    name,
    category: "subsystem" as const,
    entryPoints: entries.map((e) => e + ".**"),
    selectedContributors: [] as string[],
    extends: [] as string[],
    excludes: [] as string[],
    serve: "off",
  };
}

/** A pack: an entry-less contributor SET other compositions reference via `extends`. */
function pack(name: string, contributors: string[]) {
  return {
    id: name,
    name,
    category: "pack" as const,
    entryPoints: [] as string[],
    selectedContributors: contributors,
    extends: [] as string[],
    excludes: [] as string[],
    serve: "off",
  };
}
