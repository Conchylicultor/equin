# seed

The showcase film's data, as code: one curated, made-up session written into
the **`promo-film` composition** — the whole app (`**`, like main) served at
`http://promo-film.<checkout>.localhost:9000` with its own empty database —
so anyone can `./equin build --composition promo-film` → `./equin promo-film
seed` → record, and get the same state. Design:
`research/2026-10-29-apps-promo-film-seed.md`.

- **Only the film's instance answers.** The endpoint (`POST
  /api/promo-film/seed`, `machine/`) refuses unless this backend's namespace is
  `namespaceFor("promo-film", <its checkout>)` and its database is at first
  launch (no task, no film page) — so on main, a worktree's own app or any
  other composition it writes nothing. (It cannot be kept out of the other
  registries: `promo-film` is `**`, and a base-exclusion negative cannot be
  taken back by a composition that names everything — `composition-closure`
  refuses both spellings.) The `website` composition negates
  `apps.website.promo-film.**`: the film is made from the app, not part of
  the site.
- **Reset = first launch.** `./equin promo-film seed` (the parent plugin's
  `cli/`) runs the serve capability's own reset
  (`build/serve-composition`'s `resetServedComposition`: its guards, DB dropped
  and created empty, config re-propagated, backend restarted), then POSTs the
  seed. Every run starts from empty, so run N is run 1.
- **The demo owns its data, the apps own how it is written** (the workspace demo's recipe,
  `apps/website/demos/workspace`). The story is `machine/internal/story/`; each
  step goes through the app's writer — `writePageTree` (Pages),
  `replaceAllPlaces` (Places: real Google places saved by id, their details
  fetched first as the importer does — so the app shows Google's own photos;
  icons given so no Haiku pick runs; the host's Places key is required),
  `writeDeployFixture` (`apps/deploy/fixtures`: a site on real commits of
  main, its server a stand-in box — this instance answers its analytics and
  messages, written here through collect's and intake's own writers), `writePrototypeFixture`
  (Prototypes) — or the rows its own mutations write (tasks, attempts and
  conversations backdated as rows, as the workspace demo does).
- **A lived-in, organised workspace.** ~40 pages in nested sections with
  emoji icons (Home, TODO, Work, Projects, Music › Piano › Repertoire ·
  Practice log · Lessons, Music › Buying a piano · Listening, Travel,
  Recipes, Reading, Health, Finances, Journal, Ideas, House, Gift ideas),
  sub-pages kept as rows (`expanded: false`); twenty agent runs across the
  apps (three waiting, the rest landed as pushes) and two ideas in the
  backlog; 35 saved places, from Paris and its concert halls to Bergen,
  Vienna, Berlin and further. The sidebar's open section (Music) is the
  browser's own device-local view state (`pages-sidebar:view-state`), not seed
  data: the film's pre-roll sets it (`FILM_PAGES_OPENED.music`).
- **The page the film opens is the user's own**: Music › Buying a piano
  (`FILM_PAGES_OPENED.buying`) — short: one sentence of context, then
  "Shops", the user's checklist (`PIANO_SHOP_LIST`): each to-do "<shop>: <a
  line about it>" with its place block nested under it (one shop, ticked),
  then "Questions to ask" with three bullets, which the agent's shops push
  down as they arrive. The film's Wish ("Add more piano
  shops to this page") extends it live in ONE `edit_page`
  (`POST /api/promo-film/agent-shops`, `pageTools.edit` — the MCP tool's own
  function, on the page the film has just made an Agent page):
  `PIANO_SHOPS_ADDED` (a new to-do each, in the same form, its place under
  it), a blank line, then a `map` block, right after the last shop — every place a real Google place id
  (`{ providerId: "google", placeId }`) the page resolves itself. The Pages
  fixture carries nested blocks and `place` blocks for this
  (`apps/pages/fixtures`). **No personal name anywhere** in the story — real
  or invented (a teacher's page is "Lessons", a gift is for "My sister").
- **Files opens on the user's Piano folder, under a stand-in home.** Home is
  the film's own folder (`promoFilmWorkspaceDir/home`, the `home-folder`
  config of `infra/host-account`), so every app and the server's `~` mean it
  and the machine's real home is never read; Files' Places sidebar then names
  no checkout, volume or Trash and shows no storage meter. The Files app's
  index pane shows its `startFolder` config (`file-explorer/browser`, default
  `~`); the seed sets it to `~/Music/Piano`, so the path bar reads
  `Home › Music › Piano`. The home (`workspace.ts`, `writeHomeFolder`) holds
  `Music/Piano`, plus `Downloads` and `Documents` with a few small notes. The
  Piano folder (`story/piece.ts`, `workspace.ts`): `scores/` (Grieg's
  Wedding-day at Troldhaugen PDF and its first page as a PNG, a Chopin
  nocturne, Bach's first prelude), `music/` (the Grieg MIDI, the nocturne,
  Satie's Gymnopédie), `lessons/` (two note files) and `recital-program.txt`
  — 10 files, ~0.8 MB of Mutopia public-domain editions committed in `data/`
  and pinned by sha256, with modified times spread over the past months.
- **The Grieg conversation is an ordinary one**: `waiting`, never ended or
  hibernated, its transcript a Claude Code session file under the projects
  dir its attempt's worktree names (`claudeTranscriptPath(worktree, session)`,
  where Claude Code would have written it and the desktop's transcript watcher
  looks it up). Its `read_page` of the Piano page
  and its `edit_page` there — the agent's note, information it found about
  the piece — are RUN through the real page tools as that conversation, so the
  note records it as its author (its name's popover opens the conversation).
  Its attempt's worktree is a real folder (`promoFilmWorkspaceDir`,
  `~/.equin/cache/promo-film/att-…/`) holding the files the transcript
  leaves: `scores/` (the score PDF and its first page as an image) and
  `music/` (the MIDI) — Grieg's Wedding-day at Troldhaugen, the Mutopia
  Project's public-domain edition (piece 781), committed byte for byte in
  `data/` and pinned by sha256 in `story/piece.ts`.
- **Every run's checkout shares this repository's history**, as a real
  attempt's worktree does (`workspace.ts`, `writeRunCheckout`): a `--shared`
  clone of the repository (its objects through `objects/info/alternates`, so
  `main` as it moves is there too) on the attempt's branch
  `claude-web/<attemptId>` at `main`'s tip, with a sparse checkout matching no
  path — the tree in the index, none of it on disk. So `tasks/attempt-work`
  measures it as it measures any attempt: merge-base and ahead/behind against
  the live `main` (a checkout of its own `git init` has no merge-base with it,
  and the conversation view's standing read answered 500 — the health dot).
  The film's runs read clean (`↑0`, Drop & Close: a prototype or a page is not
  in the repository), except the Grieg run's untracked score and MIDI. Not a
  `git worktree` (`infra/worktree`): that writes ~23k files per run and
  registers each in `.git/worktrees`; a clone is registered nowhere, so the
  reset's `rm` leaves nothing to prune.
- **State the film changes, set here.** Sonata's Current key section starts
  hidden (its section slot's layout, user layer — `SONATA_SECTION_LAYOUT` /
  `SONATA_KEY_SECTION` in `core/`), so the film's Wish can show it with the
  Config pane's own write; Circle starts hidden from the launchers the same
  way (the app layout's own `hidden` flag, user layer — `APP_LAYOUT`). Circle
  is film-only, so main's committed layout does not name it: the seed writes
  the committed layout with Circle placed right after Browser, hidden, and the
  film's "implement it" (and the desktop segment) writes the layout it reads
  back with the flag dropped — both through `filmAppLayout` (`core/`), so
  Circle keeps its place. Never a reset to the committed layout: that would
  leave Circle to the reorder safety net, appended last.
  `PIANO_SHOP_LIST` / `PIANO_SHOPS_ADDED` (core) are the real Google places
  of the Buying a piano page, the user's and the ones the film's Wish adds.
- **An agent run the film's Wish asks for**: `POST /api/promo-film/agent-run`
  (`finishFilmAgentRun`, the film's instance only) writes the run an agent
  would have made for the task a Wish really filed (found by its prompt) — the
  attempt, a waiting conversation at the top of the queue, its transcript — a
  real-looking Claude Code session, modelled on the one that made Circle:
  read the prototypes guide (Bash), `./equin prototype new` (Bash, prints the
  id, so the conversation's artifacts list the prototype), Write of
  `index.html` (the fixture's real first version, ~50 KB), a headless-browser
  check (`browser_navigate` / `browser_console` / `browser_act`), the same
  page in the light theme with `?network=nearby`, ending "Your prototype is
  ready: proto-…" with a summary. The recording calls it during the P2P
  Wish's time-lapse.
- **The prototype is shared with main.** Prototype folders are host-global, so
  the seed never overwrites one: `data/` holds the Circle prototype
  (`proto-1792779833-4wgtuf`, both versions) as a Prototypes fixture; an absent
  folder is written from it, a present one must equal its newest version or
  the seed refuses. After changing the fixture, re-render its thumbnails:
  `./equin run plugins/apps/plugins/prototypes/plugins/fixtures/scripts/render-fixture-thumbnails.ts --fixture plugins/apps/plugins/website/plugins/promo-film/plugins/seed/data`
  (`promo-film:prototype-thumbnails-in-sync` fails until then).
- **The story's "now" is the film's** (`core/` film-clock): the seed counts
  every "x ago" (runs, pushes, places, files, the deploy history) back from
  the first Tuesday-to-Friday 15:00 in Paris (`FILM_WEEKDAYS`: every shop of
  the story opens then) at or after its own run (`filmNowAfter`),
  and writes that instant to `promoFilmWorkspaceDir/film-clock.json`
  (`FILM_CLOCK_FILE`, `FilmClockSchema`) — the recording pins every page's
  calendar to it. `finishFilmAgentRun` takes the page's `now` for the run it
  finishes, so it reads as just finished on that calendar.
- **A task the film files is never launched.** Wish → Create task arms
  auto-start (`armTaskAutoStart`), and the launch job returns at once on any
  namespace but main (`maybeLaunchTaskJob`: `if (!isMain()) return`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The showcase film's seed: POST /api/promo-film/seed writes the film's curated story (an organised Pages workspace with the agent's note on the Piano page, a Grieg conversation with its transcript and its score and MIDI files, twenty other agent runs, saved places across Europe, the Circle prototype) through each app's own write path; POST /api/promo-film/agent-run finishes the agent run of a task the film's Wish filed (its conversation and transcript); POST /api/promo-film/agent-shops is the shops agent's one edit_page on Buying a piano (every added shop with its place, a blank line and a map, in one apply). Booted only by the promo-film composition, and refused anywhere but its own instance.
- Excluded: yes
- Machine:
  - Uses:
    - `apps/prototypes/fixtures.readPrototypeFixtureDir`
    - `infra/endpoints.implementMachine`
    - `integrations/google-maps.getPlacesClient`
    - `integrations/google-maps/places-api.placeDetails`
  - Routes:
    - `POST /api/promo-film/seed`
    - `POST /api/promo-film/agent-run`
    - `POST /api/promo-film/agent-shops`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `packages/wall-clock.wallClockToInstant`
    - `packages/wall-clock.zoneWallClock`
  - Exports (types):
    - `FilmClock`
    - `PromoFilmSeedReport`
  - Exports (values):
    - `APP_LAYOUT`
    - `FILM_CLOCK_FILE`
    - `FILM_HOUR`
    - `FILM_PAGES_OPENED`
    - `FILM_SEEN_HINTS`
    - `FILM_WEEKDAYS`
    - `FILM_ZONE`
    - `filmAppLayout`
    - `FilmClockSchema`
    - `filmNowAfter`
    - `finishFilmAgentRun`
    - `PIANO_SHOP_LIST`
    - `PIANO_SHOPS_ADDED`
    - `PLACES_HOURS_CONFIG`
    - `PROMO_FILM_COMPOSITION_ID`
    - `PromoFilmSeedReportSchema`
    - `seedPromoFilm`
    - `SONATA_KEY_SECTION`
    - `SONATA_SECTION_LAYOUT`
    - `writeFilmShops`
- Cross-plugin:
  - Imported by: `apps/website/promo-film`
- Structure:
  - Non-standard folders: `data/`

<!-- AUTOGENERATED:END -->
