# lumen

The Lumen demo — the website's live demo: the Agent Manager, Pages and
Prototypes on one made-up story about a small notes app called Lumen. Its
scenario is `lumenDemo` (`core`) — the app, the
route it opens at (`/c/conv-demo-dark-mode`) and its browser host
(`bin/browser-host.ts`): a Web Worker booting the real server code of the
`agent-manager-demo` composition (`bin/browser-host.composition.ts`) on PGlite, seeded by
`bin/seed.ts` with one story (an agent fixing a dark mode bug in a small notes
app, three more at work in the queue, two done) — tasks, categories, attempts,
conversations, queue ranks, pushes, short titles, tracks, progress, notes, the
agents roster and their launches, and each conversation's transcript as Claude
Code JSONL (`core/internal/transcripts.ts`) the real parser reads. The stories
and agents are described once, in `core/internal/stories.ts`. The
demo owns its scenario, so the demo plugins (`framework/browser-server/demo`)
never name it. Rendered by `<DemoScope scenario><AppEmbed app route/></DemoScope>`
— the website's Live demo band and this plugin's exhibit
(`agent-manager/demo`). Original design:
`research/2026-10-15-global-app-embed-and-agent-manager-demo.md` §5.

- **The demo owns its data; the apps own how it is written.** Everything the
  demo shows is here — the stories and agents (`core/internal/stories.ts`),
  the Lumen workspace (`core/internal/pages.ts`, a Pages fixture), what the
  dark-mode agent wrote (`DARK_MODE_PAGE_WORK`), the transcripts, the
  prototypes (`data/`, a Prototypes fixture) and their tags and pin
  (`core/internal/prototypes.ts`). How each app's data is written is that
  app's fixture writer: `apps/pages/fixtures`' `writePageTree` and
  `apps/prototypes/fixtures`' `writePrototypeFixture`. Design:
  `research/2026-10-28-global-per-app-demo-seeds-v2.md`.
- **The seed writes into a live host** (`bin/seed.ts`). `bootBrowserHost`
  seeds after the post-ready phases, so triggers, the job queue and the files
  watchers are running: a page write derives its backlinks, search doc and
  history snapshot by itself, a prototype folder is adopted by the watcher.
  The seed never derives by hand — it awaits `settleJobQueue()`
  (`infra/jobs/in-process`) between steps instead (which runs debounced and
  future-dated rows now, and rejects on a dead one). In order: the page tree →
  settle → the stories (tasks, attempts and conversations backdated as raw
  rows — no mutation can backdate — queue ranks, pushes, agents, the prompt
  block origin) → the dark-mode agent's page work through the real page tools
  (`page/annotations/agent-access`'s `pageTools.read` / `edit` / `writeNote`,
  as that conversation; each call's input and exact result go into its
  transcript, the minted card and page ids read from the edit's own report)
  → settle → the transcripts → the prototypes fixture → settle.
- **Every id carries `demo`** (`conv-demo-…`, `task-demo-…`, `att-demo-…`), so a
  request that leaked past the scope to the real server is findable in its logs.
- **Nothing the demo uses goes unanswered, by construction.** The build's
  browser-host coverage guard (codegen's `core/browser-host-coverage.ts`, run
  by `deriveBrowserHostGraph`, so a gap fails `build` and `push`) reads every
  live read, endpoint and config document the scoped plugins reference and
  requires each to be served by the worker's graph or declared `needsMachine`
  (config: served, no escape). Nothing exempts it. The reads it found are
  emitted beside the scope (`hostReads` in `core/browser-host.generated.ts`),
  and `bin/browser-host.test.ts` asserts each is served by the BOOTED graph or
  declares `needsMachine` (the app renders it "not available"), so the static
  and the runtime view cannot drift. Config is
  the host's too, asserted there separately: its portable `config-v2.*` values
  are served, every registered document's origins equal the committed layer
  (`config_v2/bundled-layer`), reorder directives read their committed
  arrangement, and a `set-field` write round-trips.
- **The composition is `agent-manager-demo`** (`bin/browser-host.composition.ts`;
  its row in `plugin-meta/composition/core/config.ts`): the real
  `agent-manager` profile plus the `pages` app (`extends: ["agent-manager",
  "pages"]` — the Origin section, page chips, page artifacts and tool
  renderers, and the Pages app itself) minus what means nothing without the
  computer (push-and-exit, the automations, the file explorer), plus Prototypes
  (`apps.prototypes.**`, a positive: its tree is a `data-files` root, memory
  here — `research/2026-10-24-global-data-files-host-service.md`). Otherwise it
  only subtracts, so a plugin either app gains reaches the demo with no edit
  there. A plugin in the
  demo scope whose server half cannot join the worker fails the coverage guard
  — it is split or excluded here, never exempted.
- **The prototypes are files, committed in `data/`**, in the prototypes
  fixture layout (`apps/prototypes/fixtures`: `prototypes/<id>/` with
  `steps/v<N>.txt` + `steps/v<N>/` for history, `_picks/`, and
  `thumbnails/<fingerprint>.png`); folder ids carry `demo`
  (`demoPrototypeFixture` asserts it). `bin/bundled-prototypes.ts` inlines the
  folder into the worker bundle (`import.meta.glob`, text `?raw`, PNGs
  `?inline`); the boot test reads it off disk. A browser host renders no
  thumbnail, so the PNGs are rendered ahead of time by the gallery's own
  renderer: after editing a prototype, run `./equin run
  plugins/apps/plugins/prototypes/plugins/fixtures/scripts/render-fixture-thumbnails.ts
  --fixture plugins/apps/plugins/website/plugins/demos/plugins/lumen/data`.
  `demo:prototype-thumbnails-in-sync` (`check/`, the fixtures plugin's
  `prototypeFixtureThumbnailsCheck` over `data/`) fails the build until then,
  and the writer refuses a version with no PNG too.
- **The worker runs as its composition.** `bin/declare-namespace.ts`, the
  literal first import of `bin/browser-host.ts`, declares `agent-manager-demo`
  as the runtime namespace before the seed loads any server barrel, so portable
  code that scopes by `runtimeNamespace()` (e.g. `build.history`) answers here
  too — with this host's own rows.
- **The page scope is generated with the worker graph**
  (`core/browser-host.generated.ts`, `browserHost`: the composition's id,
  home and web plugins, and the worker's `start`), and `lumenDemo.host`
  is it — `<DemoScope>` renders the app inside `<PluginScope>` over exactly
  those plugins.
- **The graph is inferred, never listed** (`codegen/core/browser-host-gen.ts`,
  generated into `bin/browser-host.generated.ts`): every plugin of the
  composition whose server barrel is `portable: true`, the portable barrels
  `bin/browser-host.ts` loads (the seed's imports), and one provider per host
  service from the `base-exclusions` negatives (`hostProviders`). A portable
  barrel reaching a non-portable one fails codegen, naming the import chain.
- **Growing it**: a read, endpoint or config the scope newly uses that the
  worker does not serve fails the build, naming the key, the reader
  (file:line), the serving plugin and why it is outside the graph (desktop-only
  `machine/`, not in the composition, or the non-portable barrels and
  computer-bound modules that keep it out). Make the plugin that serves it
  portable (its server barrel `portable: true`, the computer-bound code in
  `machine/`) — it then joins the graph by itself — and seed its rows; a read
  or endpoint that needs the computer is declared `needsMachine` and reads
  `unavailable` here (e.g. `attempt-work`, measured from git).

## Adding an app to this demo

The app needs a fixture writer — a portable plugin under the app,
`apps/<app>/plugins/fixtures`: its `core` the fixture's type (a pure
description of "some <things>" in the app's own terms, ids the caller's) and
its `server` (`portable: true`) a writer that goes through the app's real write
path — the same mutations a user's edit makes, deriving nothing itself. Write
one if the app has none (`apps/pages/plugins/fixtures` is the model). Then:

1. Put the demo's data for it in this plugin's `core/` (or `data/` for files,
   bundled like `bin/bundled-prototypes.ts`), every id carrying `demo`.
2. Call the writer from `bin/seed.ts`, then `await settleJobQueue()` if a later
   step or the page reads what it derives.
3. Bring the app into the composition (`plugin-meta/composition/core/config.ts`,
   `agent-manager-demo`) if it is not there; the writer joins the worker graph
   through the seed's import.
4. `./equin build` — the coverage guard names any read the app's page uses
   that the worker does not serve — and assert the app's rows in
   `bin/browser-host.test.ts`.

## Making another demo

A sibling plugin under `apps/website/plugins/demos/plugins/<name>`, with its own
data and seed; no app folder changes:

- `bin/browser-host.composition.ts` naming its composition (codegen discovers a
  host by this file, and generates `bin/browser-host.generated.ts` and
  `core/browser-host.generated.ts` beside it), `bin/declare-namespace.ts`, and
  `bin/browser-host.ts` booting `bootBrowserHost({ entries, seed })` — copy
  this plugin's.
- `bin/seed.ts` writing its data through the apps' fixture writers, settling
  the queue between steps.
- `core/` exporting its `DemoScenario` (app, route, `host: browserHost`), which
  `<DemoScope scenario><AppEmbed app route/></DemoScope>` renders.
- A `bin/browser-host.test.ts` like this one (boot in a fresh process, read the
  story back through the served resources), and a `check/` naming its own
  prototype fixture directory if it has one.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The Lumen demo — the website's live demo of the Agent Manager, Pages and Prototypes on one made-up story (core: lumenDemo — the app, the route /c/conv-demo-dark-mode and its browser host: real server code in a Web Worker on PGlite, seeded with the demo's own data through each app's fixture writer — a queue of agents, one conversation fixing a bug, the Lumen pages and prototypes, every id carrying `demo`) and its exhibit, the app rendered in-process on that host.
- Core:
  - Uses:
    - `build.BUILD_CATEGORY_ID`
    - `conversations.CONVERSATIONS_CATEGORY_ID`
    - `conversations/agents.agentIdKind`
    - `conversations/agents.agentLaunchIdKind`
    - `conversations/model-provider.ConversationModelSchema`
    - `page/editor.blockIdKind`
    - `page/inline-page-link.pageLinkToken`
    - `page/prompt/link.PAGES_CATEGORY_ID`
    - `wish.WISHES_CATEGORY_ID`
  - Exports (types):
    - `DemoAgent`
    - `DemoPageSession`
    - `DemoPageToolCall`
    - `DemoStory`
  - Exports (values):
    - `DARK_MODE_PAGE_WORK`
    - `DEMO_AGENTS`
    - `DEMO_PAGE_IDS`
    - `DEMO_PAGES`
    - `DEMO_STORIES`
    - `demoAgentId`
    - `demoAgentLaunchId`
    - `demoAttemptId`
    - `demoConversationId`
    - `demoPromptOf`
    - `demoPrototypeFixture`
    - `demoStoryByKey`
    - `demoTaskId`
    - `demoTranscriptJsonl`
    - `demoWorktreePath`
    - `lumenDemo`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shadow --shadow`
- Structure:
  - Non-standard folders: `data/`

<!-- AUTOGENERATED:END -->
