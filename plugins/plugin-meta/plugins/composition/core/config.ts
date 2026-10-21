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
        // WHICH app owns bare `/` (and the app launcher's click) when this
        // composition is deployed: a `defineApp` id. A property of what is
        // deployed, not of any app's code — no app can claim the homepage. `""`
        // for a composition with no app, and allowed for a never-deployed lens
        // (subsystems, packs) even when its bundle reaches one.
        // `composition-closure` (via `resolveCompositionHome`) rejects a home
        // that is missing, not an app, or outside the bundle; codegen bakes the
        // resolved value into the composition's web registry. Engine-opaque —
        // `manifestItemToManifest` DROPS it.
        home: textField({ label: "Home app" }),
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
          // Main lands on the app gallery.
          home: "home",
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
        //
        // The others are the HOST-SERVICE PROVIDERS of a host without the
        // computer — the PGlite database driver, the in-process job queue, the
        // memory stores for attachment bytes, logs, the push ledger and
        // transcripts, the migration history bundled as text, the baseline
        // model catalog, the task titles kept as filed and the in-memory config
        // store. A desktop backend provides each of those services from a
        // machine half (`database#machine`, `jobs#machine`, `config_v2#machine`,
        // …), and a host booting two providers of one service fails boot
        // (`assertHostServices`), so no app that runs on the desktop may ship
        // them. A composition that runs without the computer takes them back by
        // naming them.
        {
          id: BASE_EXCLUSIONS_ID,
          name: BASE_EXCLUSIONS_ID,
          category: "pack" as const,
          entryPoints: [
            "!review.plugin-changes.**",
            "!database.pglite.**",
            "!infra.jobs.in-process.**",
            "!infra.attachments.memory-blobs.**",
            "!primitives.log-channels.memory-persistence.**",
            "!tasks.tasks-core.seeded-push-ledger.**",
            "!database.migrations.bundled-source.**",
            "!conversations.transcript-source.memory.**",
            "!conversations.model-provider.catalog.baseline.**",
            "!tasks.task-title.filed-titles.**",
            "!config_v2.browser-store.**",
          ],
          selectedContributors: [] as string[],
          extends: [] as string[],
          excludes: [] as string[],
          serve: "off",
          home: "",
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
          home: "agent-manager",
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
          home: "agent-manager",
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
          ...app("sonata", "apps.sonata", [], ["agent-runtime", "auth"]),
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
          home: "",
        },
        subsystem("page-editor", ["page"]),
        subsystem("fields", ["fields"]),
        subsystem("design-system", ["primitives.css"]),
        subsystem("mcp", ["infra.mcp"]),
        // The reusable baseline EVERY gateway-served app composition `extends`:
        // what BEING SERVED needs, and nothing a capability needs. Each entry is
        // a dead end nothing hard-imports, mounted from Core.Root:
        //
        // - the app SURFACE renderer (apps-core.layout — AppsLayout: the tab bar
        //   / rail / tab surface; without it a filtered app boots to a black
        //   screen);
        // - the liveness/readiness endpoint the gateway probes (infra.health,
        //   which also brings the toast host it dispatches through, by import);
        // - the runtime theme engine (its whole subtree: the quick-theme popover
        //   and the gallery a served app switches themes with);
        // - the app's own rubber-band (overscroll-hint). Left out, a served app
        //   falls back to the browser's native bounce, which pulls the whole
        //   document off the top and shows the `html` loading floor (`Canvas`,
        //   near-black) above the page instead of the page's own top edge.
        //   equin.ai shipped that way.
        //
        // What a CAPABILITY needs at runtime is never listed here: it is a
        // derived edge. A plugin that paints with a token group's var gets a hard
        // edge to the group (cross-refs `tokenUses`). A companion — contributed
        // with `companion: true` to a slot its owner opened with
        // `companions: true` — ships with that owner: the icon sprite sheet and
        // style bridge with `ui.icons`, the Google Fonts loader with the
        // font-family group, reorder's layout middleware, its node types and the
        // error boundary with slot-render. Each of those used to be hand-listed
        // here after equin.ai shipped without it (blank icons, slots ignoring
        // their committed layouts).
        //
        // Entry points (not contributors) so they're forced into the hard closure
        // unconditionally; the theme-customizer UI stays opt-in/soft.
        subsystem("served-baseline", [
          "apps-core.layout",
          "infra.health",
          "ui.theme-engine",
          "primitives.dom.overscroll-hint",
        ]),

        // ── Opt-in root mounts ───────────────────────────────────────────────────
        // A plugin mounted from `Core.Root` that nothing imports cannot be a
        // selected contributor (it soft-contributes to nothing a bundle holds),
        // so an opt-in one is an ENTRY of a row like these. The
        // `root-mounts-reached` check requires every such plugin to be named by
        // some row other than main — that naming is the decision of what it is.
        //
        // The browser-side reporters: each watches one capability (the page
        // editor's caret, optimistic mutations, live-state pushes, endpoint
        // calls, …) and files a report. Reports feed the self-improvement loop,
        // so they ship with it — the pack below extends this row — and an app
        // released without self-improvement ships none of them.
        subsystem("reporters", [
          "reports.adaptive-bar",
          "reports.caret-flight",
          "reports.collab-hydration",
          "reports.endpoint-errors",
          "reports.live-state-stale-drop",
          "reports.mutation-errors",
          "reports.optimistic-divergence",
          "reports.optimistic-rejection",
          "reports.page-undo-conflict",
          "reports.panel-overflow",
          "reports.plugin-load-errors",
          "reports.render-loop",
          "reports.resource-errors",
          "reports.theme-resolution",
          "reports.viewport-escape",
        ]),
        // Debug instrumentation mounted at the root: the render profiler, the
        // latency ledger and the synthetic live-state emitter. Main only today.
        subsystem("diagnostics", [
          "debug.latency-ledger",
          "debug.live-state-churn.emit",
          "debug.render-profiler",
        ]),
        // Opt-in root features no released app selects yet: the Cmd+K palette.
        subsystem("root-features", ["primitives.command-palette"]),

        // ── Packs: reusable contributor sets apps opt into via `extends` ────────
        {
          ...pack("self-improvement", [
            "improve.element-picker",
            "review",
            "reports.crash",
            "reports.launch-fix",
            "screenshot.draw-on-app",
          ]),
          extends: ["reporters"],
        },
        pack("theming", [
          "ui.theme-toggle",
          "ui.tweakcn",
          "ui.tweakcn.community-browser",
        ]),
        // The app-surface CHROME, opt-in and extended by nothing: the tab strip,
        // the app rail (its default `rail` variant), the multi-placement
        // surface (docked / floating / solo) and the global action bar.
        // `apps-core.layout` (in
        // served-baseline) renders a chrome-less surface — tabs + tab-surface
        // substrate only — so a composition ships the tab bar / rail / placements
        // only by `extends`-ing this pack (or selecting individual contributors).
        pack("app-chrome", [
          "apps-core.tab-bar",
          "apps-core.app-rail-framing",
          "apps-core.app-rail-framing.rail",
          "apps-core.surface",
          "apps-core.surface.docked",
          "apps.desktop",
          "apps-core.surface.solo",
          // The floating action bar (Improve, theme, view options). Opt-in: an
          // app is releasable without it, and then shows no action strip.
          "shell.global-action-bar",
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
    // An app row's name IS its `defineApp` id — the app it ships is its home.
    home: name,
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
    home: "",
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
    home: "",
  };
}
