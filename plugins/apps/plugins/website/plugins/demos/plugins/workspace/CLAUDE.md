# workspace

The workspace demo — the website's live demo: the Agent Manager, Pages,
Prototypes, Sonata, Keyboard Party, Places and Files on Demo's own equin, the story being what equin is for:
a person shaping their apps with agents. Its
scenario is `workspaceDemo` (`core`) — the app, the
route it opens at (`/c/conv-demo-practice-timer`) and its browser host
(`bin/browser-host.ts`): a Web Worker booting the real server code of the
`agent-manager-demo` composition (`bin/browser-host.composition.ts`) on PGlite, seeded by
`bin/seed.ts` with six agent sessions (one that added a practice timer to Sonata,
waiting for Demo's review; a prototype ready for review, a design question and a
roster agent at work in the queue; two pushed) — tasks, categories, attempts,
conversations, queue ranks, pushes, short titles, tracks, progress, notes, the
agents roster and their launches, and each conversation's transcript as Claude
Code JSONL (`story`'s `core/internal/transcripts.ts`) the real parser reads: several
turns, tool calls in the real tools' input and result shapes (`Read` as
`cat -n`, `./equin` as the CLI prints it), an ending that fits its state, and
the page-tool calls the seed RAN, with their real results. The stories
and agents are described once, in `story`'s `core/internal/stories.ts`. The
demo owns its scenario, so the demo plugins (`framework/browser-server/demo`)
never name it. Rendered by `<DemoScope scenario><AppEmbed app route/></DemoScope>`
— the website's Live demo band and this plugin's exhibit
(`agent-manager/demo`). Original design:
`research/2026-10-15-global-app-embed-and-agent-manager-demo.md` §5.

- **The seed runs once, at build time; the browser loads its snapshot**
  (`browser-server/host-storage`, storage `demo-workspace`). The build runs
  `bin/browser-host.snapshot.ts` in a fresh Bun process (web-artifacts'
  `host-snapshots.ts`): the worker's own graph (`bin/bun-host.ts`: the bundled
  migrations and config read off disk), filled by the real `bin/seed.ts`,
  settled, dumped with every host store into one file. `bin/browser-host.ts`
  imports it as `@browser-host-snapshot/<this plugin>` and passes it as the
  storage's `start`: a fresh storage (first visit, Reset) loads it, its times
  shifted to now, and NO seed code runs in the browser. Then the data is the
  visitor's, across reloads and every tab (one SharedWorker per build), and a
  new build migrates it. The demo's policy is `whenOutdated: "reset"`: data
  that started from an older snapshot (or from before snapshots) is replaced by
  this build's, and the page says so ("The demo was updated…"). The snapshot's
  address covers everything that can change its bytes: every module the take
  can run (the script's import graph, dynamic edges included — the whole
  server graph `browser-host.generated.ts` boots), the bundled migrations and
  config, this plugin's `data/`, the npm resolutions and the Bun version. Any
  change to the seed, a story, a migration, the config, or server code the take
  runs (a warm-up, a job, a fixture writer) ships a new one.
- **The scenario and the story are two plugins.** This plugin's `core/` is
  only what a page embedding the demo needs — `workspaceDemo` (the app, the
  route, the generated `browserHost` scope) and `externalHosts` — so the
  website's live demo band bundles nothing the story names. The story is the
  child plugin [`story`](plugins/story) (`core/` only, its prototype tags and
  featured prototype for the boot test in `core/testing`): read by `bin/`
  (seed, snapshot, boot test) and the demo e2e scripts, never by a page. The
  standalone `website` composition negates it (`!apps.website.demos.workspace.story`)
  and still ships the band: the demo's page scope is its web registry's
  on-demand `webScopedEntries`, loaded on Enter, its server halves the worker's
  (`research/2026-11-10-global-website-composition-carries-live-demo.md`).
- **The demo owns its data; the apps own how it is written.** Everything the
  demo shows is here — the stories and agents (`story`'s `core/internal/stories.ts`),
  Demo's workspace (`story`'s `core/internal/pages.ts`, a Pages fixture whose prose is
  markdown runs, so the pages show every block type), what the
  practice-timer agent wrote (`PRACTICE_TIMER_PAGE_WORK`), the transcripts, the
  prototypes (`data/`, a Prototypes fixture) and their tags and pin
  (`story`'s `core/internal/prototypes.ts`), the Sonata songs (`story`'s `core/internal/songs.ts`,
  a Sonata fixture), Demo's Places map — a real user's: ~350 well-known public places,
  most of them in Paris (Demo's city, across the arrondissements), plus the
  trips (Lisbon being planned, Tokyo next, Rome and New York been), on the
  starter tag tree plus Demo's "Trips › <city>", "Friends' tips" and "Home"
  (`story`'s `core/internal/places.ts`, a Places fixture; never a real user's saved
  places), and Demo's home folder in Files (`data/home/`, written at
  `~` of the browser's file system: Documents — notes, code, an HTML recipe,
  the Lisbon trip's papers —, Music — a recording, a MIDI piece, the practice
  log —, Pictures, and loose files — a short video clip, a note, a picture, a
  ticket, a MIDI tune; real files, path → bytes, kept tiny). How each app's data is written is that
  app's fixture writer: `apps/pages/fixtures`' `writePageTree`,
  `apps/prototypes/fixtures`' `writePrototypeFixture`,
  `apps/sonata/fixtures`' `writeSongFixtures` and `apps/places/fixtures`'
  `writePlacesFixture` (its tags through the tag tree's endpoints on the
  seed's `host`), the browser file system's `writeBrowserHomeFiles`
  (`infra/paths/data-files/memory`).
  Design:
  `research/2026-10-28-global-per-app-demo-seeds-v2.md`.
- **The prototypes, the home folder and the boot test read `data/` off disk**
  (`bin/bun-host.ts`'s `diskDemoData`: `data/home/` is Demo's home, the rest
  Prototypes'): the seed runs in Bun only, so nothing
  inlines the folder into the worker.
- **The seed writes into a live host** (`bin/seed.ts`, run by the snapshot
  script). `bootBrowserHost` seeds after the post-ready phases, so triggers, the job queue and the files
  watchers are running: a page write derives its backlinks, search doc and
  history snapshot by itself, a prototype folder is adopted by the watcher.
  The seed never derives by hand — it awaits `settleJobQueue()`
  (`infra/jobs/in-process`) between steps instead (which runs debounced and
  future-dated rows now, and rejects on a dead one). In order: the page tree →
  settle → the stories (tasks, attempts and conversations backdated as raw
  rows — no mutation can backdate — queue ranks, pushes, agents, the prompt
  block origin) → the practice-timer agent's page work through the real page tools
  (`page/annotations/agent-access`'s `pageTools.read` / `edit` / `writeNote`,
  as that conversation — its first read receives Piano practice's instructions
  card; each call's input and exact result go into its
  transcript, the minted card and page ids read from the edit's own report;
  the weekly-review agent's read of the Journal, likewise)
  → the user decorating the page the agent minted with an icon (⏳), through
  the page header's own `PATCH` sent to the host's router (`seed`'s `host`
  argument) — an agent's tools cannot set an icon, a person can — → settle →
  the transcripts → the prototypes fixture → settle → the songs → settle →
  Places → settle → the home folder → settle. (Sonata's MIDI starters are not the demo's: the MIDI source seeds
  them itself, as on a fresh install.)
- **Every id carries `demo`** (`conv-demo-…`, `task-demo-…`, `att-demo-…`, the
  pages and the blocks a record names), so a request that leaked past the
  scope to the real server is findable in its logs. The blocks of a page's
  markdown runs, which nothing names, get fresh ids from the writer.
- **The user is "Demo"** — the browser host's guest account
  (`infra/host-account/guest`), so Pages reads "Demo's pages". No fictional
  product, and no staged story about equin: the pages are what a person
  keeps (a welcome listing what to try, piano notes, a journal, ideas, a tour
  of every block), the songs are chord grids that read as songs, and every
  task is a change Demo asked of their own apps.
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
  `agent-manager` profile's entries, extends and selection — but for its
  adapters into Places, since the demo ships Places — plus the `pages` app
  (the Origin section, page chips, page artifacts and tool renderers, and the
  Pages app itself) minus what means nothing without the
  computer (push-and-exit, the automations), plus Prototypes
  (`apps.prototypes.**`, a positive: its tree is a `data-files` root, memory
  here — `research/2026-10-24-global-data-files-host-service.md`), Home
  (`apps.home.**`, the app gallery, minus its onboarding tour) and Sonata
  (`apps.sonata.**`, minus transcription, as Sonata's own app composition
  ships it — but with the MIDI file preview, Sonata's adapter into Files'
  viewer, which this demo has;
  `research/2026-11-04-global-sonata-in-browser-demo.md`), and the Desktop
  (`apps.desktop.**`, minus its Openverse wallpaper source, which searches an
  external API: picked from the launcher inside the embed, as on main, it
  turns the embed's own tab set into floating windows — its layout lives in
  the embed, never in the page's storage, and its pinned apps and wallpaper
  are the worker's config; importing a wallpaper from a link says "not
  available"; `research/2026-11-04-global-desktop-mode-in-browser-demo.md`),
  and Keyboard Party (`apps.keyboard-party.**`, whole: its server half only
  registers the party's settings, which the worker's config serves at their
  product defaults, and the toy loads nothing — emoji pictures, sounds
  synthesized with WebAudio, the browser's own `speechSynthesis`;
  `apps/demo`'s `keyboard-party-in-demo.ts`).
  Places (`apps.places.**`, with `map.google` selected) draws Google's map
  with the browser key the page's chrome hands the worker (a page input,
  `google-maps/page-config`; never in the snapshot); searching, saving,
  Google's details and photos, the icon pick and Ask need the computer and say
  so (`research/2026-11-06-global-places-in-browser-demo.md`). Files
  (`apps.file-explorer.**`, whole, listed) browses the browser's own file
  system (`file-systems`' `browser`): it opens on its Home, which the seed
  filled from `data/home/` (`writeBrowserHomeFiles`), with the apps' folders
  under the hidden `~/.equin/` — and leaves out the computer's disk, which
  this host does not serve; `apps/demo`'s `file-explorer-in-demo.ts` opens
  each viewer.
  The third-party
  hosts the demo may reach are the scoped plugins' `ExternalHosts.Declare`s
  (`externalHosts`, exported from `core`), which `apps/demo`'s e2e hold every
  off-origin request to. Sonata's samples load
  through the worker's asset mirror (`infra/asset-mirror`, portable), fetched
  from the instruments' public CDNs once per browser profile (the mirror's
  cache is the host's `data-files` store, kept in the demo's IndexedDB;
  `apps/demo`'s `sonata-in-demo.ts` asserts both); reading Ultimate Guitar,
  aligning a sheet to a recording and watching MIDI folders need the computer
  and say so. Home is the composition's home, as on
  main, so the launcher inside the embed lists the Agent Manager and its "All
  apps" opens the gallery. The demo still opens on the Agent Manager:
  `workspaceDemo` names its app. Otherwise it
  only subtracts, so a plugin either app gains reaches the demo with no edit
  there. A plugin in the
  demo scope whose server half cannot join the worker fails the coverage guard
  — it is split or excluded here, never exempted.
- **The prototypes are files, committed in `data/`**, in the prototypes
  fixture layout (`apps/prototypes/fixtures`: `prototypes/<id>/` with
  `steps/v<N>.txt` + `steps/v<N>/` for history, `_picks/`, and
  `thumbnails/<fingerprint>.png`); folder ids carry `demo`
  (`demoPrototypeFixture` asserts it), read off disk by the snapshot script
  and the boot test (`bin/bun-host.ts`). A browser host renders no
  thumbnail, so the PNGs are rendered ahead of time by the gallery's own
  renderer: after editing a prototype, run `./equin run
  plugins/apps/plugins/prototypes/plugins/fixtures/scripts/render-fixture-thumbnails.ts
  --fixture plugins/apps/plugins/website/plugins/demos/plugins/workspace/data`.
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
  home and web plugins, and the worker's `start`), and `workspaceDemo.host`
  is it — `<DemoScope>` renders the app inside `<PluginScope>` over exactly
  those plugins.
- **The graph is inferred, never listed** (`codegen/core/browser-host-gen.ts`,
  generated into `bin/browser-host.generated.ts`): every plugin of the
  composition whose server barrel is portable (derived from its static
  closure, `serverPortabilityOf` — no flag), the portable barrels
  `bin/browser-host.ts` loads (the seed's imports), and one provider per host
  service from the host providers (plugins whose `server/` provides one, which
  no composition bundles; emitted as `hostProviders`). A portable
  barrel reaching a non-portable one fails codegen, naming the import chain.
- **Growing it**: a read, endpoint or config the scope newly uses that the
  worker does not serve fails the build, naming the key, the reader
  (file:line), the serving plugin and why it is outside the graph (desktop-only
  `machine/`, not in the composition, or the non-portable barrels and
  computer-bound modules that keep it out). Make the plugin that serves it
  portable (the computer-bound code of its server closure moved to
  `machine/`) — it then joins the graph by itself — and seed its rows; a read
  or endpoint that needs the computer is declared `needsMachine` and reads
  `unavailable` here (e.g. `attempt-work`, measured from git).

## Adding an app to this demo

The app needs a fixture writer — a portable plugin under the app,
`apps/<app>/plugins/fixtures`: its `core` the fixture's type (a pure
description of "some <things>" in the app's own terms, ids the caller's) and
its `server` (portable: nothing in its closure needs the computer) a writer that goes through the app's real write
path — the same mutations a user's edit makes, deriving nothing itself. Write
one if the app has none (`apps/pages/plugins/fixtures` is the model). Then:

1. Put the demo's data for it in `story`'s `core/` (or this plugin's `data/` for files,
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
  `bin/browser-host.ts` serving `bootBrowserHost({ entries })` on a storage
  that starts from its snapshot — copy this plugin's.
- `bin/seed.ts` writing its data through the apps' fixture writers, settling
  the queue between steps, and `bin/browser-host.snapshot.ts` (+
  `bin/bun-host.ts`) running it at build time — the build takes the snapshot
  by that file's presence.
- `core/` exporting its `DemoScenario` (app, route, `host: browserHost`), which
  `<DemoScope scenario><AppEmbed app route/></DemoScope>` renders.
- A `bin/browser-host.test.ts` like this one (boot in a fresh process, read the
  story back through the served resources), and a `check/` naming its own
  prototype fixture directory if it has one.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The workspace demo — the website's live demo of the Agent Manager, Pages, Prototypes, Sonata and Keyboard Party on Demo's own equin (core: workspaceDemo — the app, the route /c/conv-demo-practice-timer and its browser host: real server code in a Web Worker on PGlite, starting from a build-time snapshot of the demo's own data written through each app's fixture writer — agents at work on Demo's wishes, one waiting for review after adding a practice timer to Sonata, pages showing every block type, prototypes and songs, every id carrying `demo`) and its exhibit, the app rendered in-process on that host.
- Cross-plugin:
  - Uses tokens: `ui/tokens/shadow --shadow`
  - Imported by:
    - `apps/demo`
    - `apps/demo/shell`
    - `apps/website/landing/screenshot`
- Core:
  - Exports (values):
    - `externalHosts`
    - `WORKSPACE_DEMO_STORAGE`
    - `workspaceDemo`
- Structure:
  - Non-standard folders: `data/`
- Sub-plugins:
  - **`story`** — The workspace demo's story, as data: the agents' stories and transcripts, Demo's pages, prototypes' tags, songs and places — what the demo's build-time seed writes through each app's fixture writer…

<!-- AUTOGENERATED:END -->
