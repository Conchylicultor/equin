# demo

The Agent Manager's demo scenario: `agentManagerDemo` (`core`) — the app, the
route it opens at (`/c/conv-demo-dark-mode`) and its browser host
(`bin/browser-host.ts`): a Web Worker booting the real server code of the
`agent-manager-demo` composition (`bin/browser-host.composition.ts`) on PGlite, seeded by
`bin/seed.ts` with one story (an agent fixing a dark mode bug in a small notes
app, three more at work in the queue, two done) — tasks, categories, attempts,
conversations, queue ranks, pushes, short titles, tracks, progress, notes, the
agents roster and their launches, and each conversation's transcript as Claude
Code JSONL (`core/internal/transcripts.ts`) the real parser reads. The stories
and agents are described once, in `core/internal/stories.ts`. The
app owns its scenario, so the demo plugins (`framework/browser-server/demo`)
never name it. Rendered by `<DemoScope scenario><AppEmbed app route/></DemoScope>`
— the website's Live demo band and this plugin's exhibit
(`agent-manager/demo`). Design:
`research/2026-10-15-global-app-embed-and-agent-manager-demo.md` §5.

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
- **The prototypes are files, committed in `data/`.** `data/prototypes/` is
  laid out like the app's data dir: one folder per prototype (ids
  `proto-<epoch>-demoNN`), `_picks/<id>.json` the user's picks, and in a
  folder `steps/v<N>.txt` (subject, then body) + `steps/v<N>/` (the files
  that version changes) for its history — read by `core`'s
  `demoPrototypeSeed`. `bin/seed-prototypes.ts` inlines the folder into the
  worker bundle (`import.meta.glob`, text `?raw`, PNGs `?inline`) and seeds,
  in order: each folder's `v0` into the `prototypesFiles` root, its history
  (adopted, then one recorded version per step through the host's
  `PrototypeHistoryStore`), the picks, the gallery's rows (tags, each
  prototype's tag, the pin) and the thumbnails. A browser host renders no
  thumbnail, so `data/thumbnails/<fingerprint>.png` are rendered ahead of time
  by the gallery's own renderer — `./equin run
  plugins/apps/plugins/agent-manager/plugins/demo/scripts/render-demo-thumbnails.ts`
  (which lays every version out in a temp tree and runs `./equin prototype
  thumbnails` over it) — and written into the thumbnail cache root, so every
  seeded version, and a restore of one, is a cache hit. After editing a seed
  file, re-run it: `demo:prototype-thumbnails-in-sync` (`check/`) fails the
  build while a version has no PNG or a PNG no version, and the seed throws on
  a missing one too.
- **The worker runs as its composition.** `bin/declare-namespace.ts`, the
  literal first import of `bin/browser-host.ts`, declares `agent-manager-demo`
  as the runtime namespace before the seed loads any server barrel, so portable
  code that scopes by `runtimeNamespace()` (e.g. `build.history`) answers here
  too — with this host's own rows.
- **The page scope is generated with the worker graph**
  (`core/browser-host.generated.ts`, `browserHost`: the composition's id,
  home and web plugins, and the worker's `start`), and `agentManagerDemo.host`
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

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The Agent Manager's demo scenario (core: agentManagerDemo — the app, the route /c/conv-demo-dark-mode and its browser host: real server code in a Web Worker on PGlite, seeded with a queue of agents and one conversation fixing a bug, every id carrying `demo`) and its exhibit, the app rendered in-process on that host.
- Core:
  - Uses:
    - `apps/prototypes/files.protoIdKind`
    - `apps/prototypes/thumbnails.fingerprintFiles`
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
    - `DemoContentBlock`
    - `DemoNode`
    - `DemoPage`
    - `DemoPageSession`
    - `DemoPageToolCall`
    - `DemoPrototype`
    - `DemoPrototypeData`
    - `DemoPrototypeSeed`
    - `DemoPrototypeTree`
    - `DemoPrototypeVersion`
    - `DemoStory`
  - Exports (values):
    - `agentManagerDemo`
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
    - `demoPrototypeDataOf`
    - `demoPrototypeSeed`
    - `demoStoryByKey`
    - `demoTaskId`
    - `demoTranscriptJsonl`
    - `demoVersionFingerprint`
    - `demoWorktreePath`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shadow --shadow`
- Structure:
  - Non-standard folders: `data/`

<!-- AUTOGENERATED:END -->
