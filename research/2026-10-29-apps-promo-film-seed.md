# promo-film seed: curated, reproducible data for the showcase film

## Context

The showcase film (`research/2026-10-28-apps-promo-film-v2.md`, script: the Script v2 page) is recorded by driving the real app in headless Chromium. Recording against main shows messy real data, and main refuses agent writes, so the Wish → Create task beat cannot be real there. The user wants fake but realistic, curated data that is **code in the repo**: anyone can run build → seed → record and get the same state, independent of any worktree's DB (worktrees get cleaned up; a worktree DB is a fork of main's real data).

Not the Lumen browser host (`apps/website/demos/lumen`, DemoScope): it has no app chrome (action bar, Wish, rail), and Files, Sonata, Places, Deploy, Chord and Desktop do not run there. Lumen's *recipe* is reused: the demo owns its data, each app owns its fixture format and writer, and the seed writes into a **live** host through the apps' own write paths.

## Decision: a served composition with its own empty database

`./equin build --composition <id>` already serves a composition at `http://<id>.<checkout>.localhost:9000` with **its own empty database and config dir** (`build/serve-composition`), and `resetCompositionData(id)` (`build/serve-composition/server/internal/reset.ts`) already resets one to first launch: four guards (never main/central, a `composition.json` marker must prove a serve build owns the namespace, no collision with a real worktree, `serve` not `off`), then DROP + CREATE the DB, wipe the config dir and re-propagate the git-layer config, and restart the backend.

So the film gets a composition, `promo-film`:

- `entryPoints: ["**"]`, the whole app like main (`MAIN_COMPOSITION_ID`'s row), plus the seed plugin named positively. `serve: "manual"`, `home: "home"`.
- The DB starts **empty** (migrations only). There is no table list to keep in sync: the film's state is migrations + boot seeds + this seed. Nothing of main's data, and no fork.
- Its namespace is `promo-film.<checkout>`, never main, so `isMain()` is false. That keeps every main-only side effect off, auto-launch included (see Create task below).

**Reset** = `resetCompositionData`, reused rather than copied. It reads the manifest through `runtimeNamespace()`'s user config, which a CLI process does not have. It therefore gains an explicit parameter: the namespace whose user config holds this checkout's manifest. It defaults to `runtimeNamespace()` for the endpoint; the CLI passes `checkoutNamespace(root)`. Every guard stays.

## Where it lives

`plugins/apps/plugins/website/plugins/promo-film/plugins/seed/`, a child of the film plugin:

| Folder | Holds |
|---|---|
| `core/` | The story, as data: the ids (every one carries `film`), the pages tree (a Pages fixture), the conversation and its transcript turns, the workspace files, the MIDI piece (notes), the places, the deploy servers and runs, the chord history. Plus the endpoint contract. |
| `machine/` | The seed itself, run **inside the composition's serving backend** (the files watcher, jobs and change feed are live). The `POST /api/promo-film/seed` handler refuses unless the runtime namespace is `promo-film.<checkout>` **and** the DB holds no film data yet. It is `machine/` because it writes files (the transcript JSONL, the workspace folder). |
| `cli/` | `./equin promo-film seed`: guard, reset, wait for the backend, POST the seed, print a summary. |
| `data/` | Committed non-code fixtures: the Circle prototype as a Prototypes fixture (`prototypes/`, `thumbnails/`). |

`base-exclusions` negates `apps.website.promo-film.seed`, so main and every other composition never boot the seed endpoint. Only the `promo-film` row names it, and the engine's protection rule lets a local positive win.

## Per-surface data and write paths

1. **Pages.** One workspace, a small music-practice wiki. The root page is "Recital prep", starred and tagged; it has sub-pages "Repertoire" and "Practice log", and an "Ideas" root. Its text names the conversation by id (`conv-…film…`), which the id-kinds chip recognises. It is written with `writePageTree` (`apps/pages/plugins/fixtures/server`).
2. **Agent Manager conversation.** It is an ordinary idle one: `status: "waiting"`, no `endedAt`, no `hibernatedAt`, no note, a `claudeSessionId`. It is written like Lumen's `bin/seed.ts`:
   - `createTask` (interactive mandate) and the short title;
   - the attempt and conversation rows (backdated);
   - the progress phase and the queue rank.

   The machine reads transcripts from `~/.claude/projects/*/<sessionId>.jsonl` (`transcript-watcher`'s `findTranscriptPath`). The seed writes one file in Claude Code's JSONL shape (Lumen's `transcripts.ts` recipe) into a dedicated `-equin-promo-film` project dir, keyed by a fixed UUID. The story: "turn the Minuet in G's first eight bars into a practice file". The agent reads the repertoire page, writes `minuet-in-g.mid` and `practice-notes.md` with Write tool calls (absolute paths, so the file chips resolve), and ends on a question. It is a normal transcript ending in the composer.
3. **Files.** The attempt's `worktreePath` is a real folder the seed writes: `<dataRoot>/demos/promo-film/recital/` (a declared data dir). It holds the `.mid`, the notes and a few sibling files. The file chip opens `file-peek`, and its Expand opens Files at `/files/at/<folder>/<file>`.
4. **Sonata.** The `.mid` is generated at seed time from note data in `core/` with `@tonejs/midi` (Bach, Minuet in G, BWV Anh. 114, public domain, as Sonata's starters do: no binary blob). In Files, the MIDI preview's own "Open in Sonata" imports the file (`importMidiBytes`) and lands on the player. Nothing is pre-imported, so that click is real.
5. **Places.** About a dozen custom places (no Google ids, so no Places-key calls) in one city, tagged Want to go / Been / Food / Museum. They go through `replaceAllPlaces` (`places-core/server`, the importer's own path). The map key is host-global, so it is unaffected by the empty DB.
6. **Deploy.** Deploy has no writer, so a **Deploy fixture writer** is added in the app: `apps/deploy/plugins/fixtures` (core: `DeployFixture`; server: `writeDeployFixture`). It writes through the same tables the create handlers write: a server, its health row, one deployment and finished runs (never `running`), all recent. The server is a documentation-only address (`203.0.113.x`).
7. **Chord.** The index is derived from a pinned download. The seed triggers the real `ensure` path and lets the backend's job build it, so nothing is hand-faked. Practice history (rounds and answers) goes through a **Chord fixture writer** (`apps/chord/plugins/fixtures`) over the progress plugin's own `recordRound`. If the index cannot be made ready offline, the surface is reported as partial.
8. **Wish → Create task.** No seed beyond the committed preprompts config. "Auto-push and exit" is in the repo's `config/conversations/preprompts/config.jsonc`, which the reset re-propagates. Create task calls `createTaskChain`, which arms auto-start (`armTaskAutoStart`). `maybeLaunchTaskJob` begins `if (!isMain()) return;`, so on `promo-film.<checkout>` the task is filed and **never launched**. No worktree, no agent, nothing that can push. The seed verifies this by test: it calls the same handler and asserts no conversation follows.
9. **Prototypes.** Prototype files are host-global (`~/.equin/apps/prototypes`, shared with main by design), so the seed never overwrites them. The committed fixture is `proto-1792779833-4wgtuf` (its folder and history). If it is absent, the seed writes it with `writePrototypeFixture` (the watcher is live in the serving backend). If it is present, the seed verifies the newest version's fingerprint equals the fixture's and refuses loudly otherwise. The pin is a `prototype_state` row in the composition DB.
10. **Desktop.** Windows live in sessionStorage, so there is no seed. The recorder opens them through the shelf.
11. **Noise.**
    - A fresh DB has no notifications, reports, build runs or queue backlog, which covers the bell, the Reload pill and "Building".
    - The health dot is machine state (gateway, Claude Code, watcher). The seed reads the report and **prints** any row that is not ok, rather than hiding it.
    - The task list holds about 6 tidy tasks: the film conversation's, 2 done with pushes, and 2 queued in the backlog.

## Idempotency

Every run starts from the reset: an empty DB and a re-propagated config. So run N equals run 1 by construction. The endpoint additionally refuses a DB that already holds the film's root page. The disk writes are absolute and deterministic: the workspace folder is replaced, and the transcript file is overwritten.

## How the recorder targets it

`./equin build --composition promo-film` writes the deploy registry entry. The e2e harness resolves it with `--composition promo-film` (`screenshot.ts --composition promo-film`). The recorder passes the same flag, and needs no URL.

## Verification

- `./equin build --composition promo-film` (background), then `./equin await`.
- `./equin promo-film seed` twice, then compare a table of row counts and ids each run prints.
- Screenshots via `screenshot.ts --composition promo-film`, one per surface:
  - the Pages page;
  - the conversation;
  - the file peek;
  - Files at the folder;
  - the MIDI preview, then Sonata;
  - Places;
  - Deploy;
  - Chord;
  - the Wish popover;
  - the prototype;
  - the desktop.
- One real Create task through the UI, then confirm no conversation was created for it (`query_db` on the composition DB).
- `./equin format`, then `./equin check format-clean type-check boundary-rules plugin-boundaries paths:no-hardcoded-paths composition-closure plugins-registry-in-sync`.

## As built (deviations from the plan above)

- **No base exclusion.** `promo-film` is `**`, and `composition-closure` refuses both ways of taking a base-excluded plugin back (an entry positive contradicts the inherited negative; a selected contributor is "already in the hard closure"). So the seed plugin is in every registry, and its endpoint refuses on any namespace but `promo-film.<its checkout>` and on any database not at first launch (rung 4, not rung 1). The `website` composition negates `apps.website.promo-film.**`, since the seed reaches agent-runtime.
- **Reset is the serve capability's own reset.** `resetCompositionData` gained a `manifestNamespace` parameter, defaulting to `runtimeNamespace()`. The CLI calls it through the lazy `resetServedComposition` export. The row is `serve: "manual"` because the reset guard refuses `off`. `manual` never rebuilds automatically, and the config test now asserts exactly that.
- **Each run's workspace is a real git checkout.** Without one, `edited-files` and `attempt-work` failed their loaders, which put a dot on the health indicator. Each run gets `main` with one base commit and its own branch. The practice run's files are uncommitted changes on that branch. The files sit under `practice/`, because the file-chip grammar needs a folder segment.
- **Deploy key.** `servers` exports `generateServerSshKey`, the write that the Generate key button makes. The fixture's server has a fixed id, so every seed replaces the same entry in the host secrets store.
- **Onboarding tips.** The CLI marks the tips and the Home tour seen (`FILM_SEEN_HINTS`, through `markHintSeenEndpoint`), so the instance reads as a returning user's.
- **Chord** is the real index, ensured after the seed. There is no practice history.
