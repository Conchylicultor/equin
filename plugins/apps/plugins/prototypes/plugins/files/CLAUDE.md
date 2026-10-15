# files

Server-side file serving for the Prototypes app, plus the live-state resources
that drive gallery refresh and iframe auto-reload.

## Where the content lives: the `apps/prototypes` data dir (`prototypesDir`)

This plugin creates the dir, mints prototypes into it, serves it and watches
it — but it does not DECLARE it. The dir is the Prototypes app's one data dir,
declared at the app root (`plugins/apps/plugins/prototypes/data-dirs/index.ts`,
via `defineAppDataDir(prototypesApp, …)`), because an app owns exactly one
`apps/<app>` dir and everything it keeps durably lives inside it. Every consumer
(this plugin, `thumbnails`, the `prototypes` backup source, the main-edits
guard) imports `prototypesDir` from `@plugins/apps/plugins/prototypes/data-dirs`
directly; never re-derive the path, and never re-export it from a barrel.
Something new that belongs to the app goes inside it
(`prototypesDir.subdir("<area>")`), not in a second `apps/*` dir.

Host-global, outside every checkout, and NOT in git. One shared set that every
worktree backend and main serve, so a mock is visible on the always-running main
app the moment it is written — no build, no commit, no merge — and it survives
the worktree that authored it. Recoverable through the `prototypes` backup
source (git no longer is the safety net).

The one exception is `_template/`, which IS code: it lives in the repo
(`prototypes/_template/`) and is read from there, never copied into the data
dir. A mint copies it from the checkout that is running — main's app from
main's template, a worktree's deploy or CLI from its own branch's — so a
template change reaches new prototypes the moment it lands, and can be tried on
a branch first. (There used to be a copy in the data dir, seeded once on boot
and never overwritten; every template change after that seed silently stopped
reaching new prototypes.)

Enforcement splits the same way. The `prototypes:self-contained` check now only
guards the repo half — the template is valid, and no prototype folder is
committed. Authored prototypes are validated at read time by
`validatePrototypeFolder` (`core/validate.ts`, shared with the check) and their
problems ride out on `PrototypeMeta.problems` to the gallery card. A throwaway
mockup must never be able to fail somebody's code push.

## The id, and the mint that hands it out

A prototype's folder name IS its id, and it is minted rather than invented:
`protoIdKind` (`core/id.ts`) is a `defineIdKind` declaration (`plugins/ids`)
— `protoIdKind.mint()` hands out `proto-<epochSeconds>-<6 base36 chars>`,
`protoIdKind.is()` validates a folder name, and its `pattern` is what the
active-data chip and `prototypeIdsIn` recognise. One declaration, so the chip
that linkifies a bare id in assistant prose cannot silently stop matching when
the mint changes; `core/id.test.ts` pins it against real mints. Folders minted
with the older 4-char suffix stay valid: recognition is the generic body every
kind shares.

Why the folder name and why opaque: the filesystem is then the uniqueness
authority (the mint is a `mkdir`), there is no dir↔id map in front of the routes,
the watcher, the thumbnail cache or the backup source, and no wholesale rewrite
of `index.html` can drop the id. Opaque because the folder is minted BEFORE the
agent has designed anything — a slug chosen at that moment is a guess, and
renaming later would change the id. Nothing is lost to a human: every surface
displays `meta.title`, read out of `<title>`.

`shared/mint.ts` — `mintPrototype({ title? })` → `{ id, dir }` — is the one way a
prototype comes into existence. It copies the running checkout's
`prototypes/_template/` (`templateDir()`) into a fresh id, then stamps `<title>`
when a name was given. It
lives in `shared/` because it touches `fs` (so not `core/`, which the browser
imports) and because `./singularity prototype new` calls it with no backend
running (so not `server/`) — the same split `shared/read-folder.ts` makes.

`shared/template.ts` holds `templateDir()` (the running checkout's template;
throws when it is missing) and `copyFolderOnce()` (temp-then-rename, never
overwrites, treats a lost rename race as "somebody else got there first"), which
the mint copies through.

Three consequences worth knowing:

- `POST /api/prototypes` (`createPrototype`, body `{ title? }` → `{ id }`) is how
  the gallery mints before it launches an agent, so the agent is handed a folder
  that already exists and is never asked to name anything. It notifies nothing:
  the mint writes into the watched tree, and the watcher is what re-broadcasts
  the list.
- A folder whose name is not a minted id gets a `problems[]` entry naming
  `./singularity prototype new` as the fix. A *problem*, not a refusal —
  prototypes are user content, so a hand-made folder keeps being listed and
  served; what it loses is being referenceable by id.
- That rule skips `_`-prefixed directories, because `check/index.ts` runs
  `validatePrototypeFolder` over `_template` itself.

Design: `research/2026-08-21-global-prototype-ids-and-mint.md`.

## Version history (`shared/history/`)

Every agent turn that changes a prototype is recorded as a version; the detail
pane steps through them and can restore one; `prototype log -p` is how the next
agent reads the evolution. Design:
`research/2026-09-11-apps-prototype-version-history.md`.

**One private bare git repo per prototype, at `_history/<id>.git`, whose work
tree is the prototype folder.** Beside the folder, not in it: a prototype is
flat, and a `.git` inside would churn the signature and the thumbnail
fingerprint. `_history/` is `_`-prefixed, so `listPrototypeDirNames` skips it
like `_template/`, and both file routes refuse it (404). Not the `history/engine`
DB: prototypes are host-global and forever, a worktree DB is neither.

- `store.ts` — `openHistoryStore(root)`; the caller resolves the root
  (`prototypesDir.path`, per call; the tests pass a temp dir). Ops:
  `ensureHistory` (v0 = the folder as it is; built in a staging dir and renamed
  in, so an existing repo always has its baseline), `adoptAll`, `checkpoint`
  (`add -A`, commit only if `diff --cached` moved; a `messageId` already on a
  commit is `unchanged` — the turn event is at-least-once), `readHistory`
  (versions + `dirty`; adopts on first read; each version carries the options
  its own `index.html` declares, read for every not-yet-seen version in ONE
  `git cat-file --batch` and remembered by commit sha, since a commit never
  changes), `readVersionFile` (bytes via
  `cat-file blob`), `readVersionPatch`, `restoreVersion` ("Before restore" if
  dirty → `read-tree -u --reset <sha>` → "Restored vN"). Every arg that becomes a
  path or a revision is validated first (`protoIdKind.is`, `isVersionSha`,
  `isFlatFileName`).
- `message.ts` — the commit message format, written and read in one module:
  subject (≤ 72), body (the request + agent summary), then `Prototype-Kind` /
  `Prototype-Conversation` / `Prototype-Message` trailers. `n` is the commit's
  position, never stored.
- `git.ts` — hermetic git: the environment is REPLACED (`GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_NOSYSTEM=1`, no leaked `GIT_DIR`/`GIT_INDEX_FILE`), hooks and
  signing off, fixed identity, `GIT_OPTIONAL_LOCKS=0` so a `status` never takes
  the index lock a write needs. Spelled `git`, not `paths/server`'s `GIT`:
  `shared/` may not import a `server` barrel.
- `lock.ts` — one flock per repo (`_history/<id>.lock`, never unlinked); a
  writer waits ≤ 10 s, then throws `HistoryBusyError` (the job retries).

**How a recorded version reaches every backend.** After each commit the store
writes `_history/<id>.git/latest.json` (`{ n, sha }`, temp-then-rename). Git's
own files have no extension, so they never pass the watcher's extension filter;
this stamp does, and the watcher turns it into a notify of that one id's
`prototypes.history` — without re-reading the list (so no frame reloads), since
the prototype's bytes did not move. Folder edits reach it through the signature
gate, which is per folder so it can name the prototypes whose `dirty` may have
flipped. Nothing notifies after a write in-process; the stamp is the one signal.

Adoption: `mintPrototype` calls `ensureHistory` (v0 = the page as minted — the
title is stamped in the staging copy, before the folder is visible); boot and
every real tree change run `adoptAll`, so the prototypes that predate history,
and any folder made by hand, get a v0. Every backend races to do it; the lock
makes one win.

## Option picks (`shared/picks.ts`)

Which variant of each option the user picked is ONE record per prototype,
`_picks/<id>.json` (`{ "palette": "azure" }`), shared by every surface: main,
every worktree deploy, every browser, and the CLI. It used to be per-browser
localStorage, which left agents blind (their headless browser saw only the
defaults) and gave each `*.localhost:9000` origin its own picks. Design:
`research/2026-09-16-global-shared-prototype-option-picks.md`.

- **Raw, grammar-checked only** (`isOptionName` / `isPickValue` from
  `core/options.ts`, `v` reserved: a value token, or a color option's
  lowercase `#rrggbb`) — never judged against the live declaration, because a pick can target an option only a recorded version
  declares. Every read still goes through `resolvePicks`, per document.
- `openPicksStore(root).write(id, change)` — one `set` or `reset` (never the
  whole record, so two surfaces picking different options cannot clobber each
  other), read-modify-write under the per-prototype flock (`withHistoryLock`,
  `_picks/<id>.lock`), temp-then-rename with a `.tmp` suffix the watcher's
  extension filter skips. A reset unlinks the file; a no-op writes nothing.
  Missing file = `{}`; a malformed file THROWS (never read as "nothing picked").
- `prototypes.picks` (push, keyed by `name`) + `PUT /api/prototypes/:name/picks`
  (`setPrototypePicks`). The writer notifies at once; every other backend hears
  it through the watcher (`picks-recorded`, `tree-path.ts`), which re-reads
  nothing else — the frames reload because their `src` carries the picks.
- **Automated sessions are undone.** The PUT records into the
  `prototype-picks` agent-write ledger
  (`infra/request-origin/agent-write-ledger`) inside the lock, around the one
  write, so an E2E that clicks the picker has its picks put back when its run
  ends. Agents never write picks: there is no CLI setter, and a variant is
  rendered through its document URL (`?<option>=<value>`), which saves nothing.
- `_picks/` is `_`-prefixed, so it is never listed as a prototype and never
  enters the reload signature; the file routes refuse it (404) like `_history/`.

## Per-prototype records (`shared/record-store.ts`)

The picks above are one kind of **record**: a small JSON file per prototype in
a `_`-prefixed dir beside the folders (`_<kind>/<id>.json`), never inside the
folder (it would churn the reload signature, the thumbnail and the history).
`openRecordStore(root, kind)` owns everything the kinds share — the id-checked
path, the per-prototype flock, the temp-then-rename write, "the empty record is
no file", `readAll()`, snapshot `restore()` for the agent-write ledger, and
"a malformed file throws". A kind supplies its dir, schema, empty value, fold
and equality. A new kind is a `shared/<kind>.ts` of that shape, plus its
server resource/PUT, a `tree-path.ts` arm, a watcher notify and its dir in
`isInternalDir`.

## Status (`shared/status.ts`)

Whether the user marked a prototype **Done**, and whether they **pinned** it:
`_status/<id>.json` (`{ "done": true, "pinned": false }`; no file = neither; a
file from before pins holds `done` alone and reads as not pinned), shared by every surface exactly like
the picks.

- `prototypes.statuses` (push, no params) — every recorded status keyed by id;
  a prototype missing from the map is neither done nor pinned (`statusOf`). One small record
  per prototype, so it is bounded by the list it annotates, which the gallery
  holds whole anyway.
- `PUT /api/prototypes/:name/status` (`setPrototypeStatus`, body `{ done?, pinned? }` — the fields
  it sets, so a pin never clobbers Done),
  404 for an unknown prototype. Notifies at once; other backends hear it through
  the watcher (`status-recorded`). Automated sessions are undone through the
  `prototype-status` agent-write ledger, like picks.
- `prototype list` prints `[done]` after a Done prototype's title.

## `./singularity prototype`

Six verbs, contributed as a `cli/` collected dir — auto-discovered, so there is
no registry edit and no codegen edit; `./singularity build` regenerates
`cli.generated.ts` from the filesystem.

- `prototype new [title]` — mint a folder and print its id, its path and its URL.
- `prototype list` — id, title and URL for every prototype on disk, a
  `picked:` line when the user's picks differ from the defaults, plus any
  `problems[]` the folder carries.
- `prototype options <id>` — each option with the value on screen (picked /
  default; a color as its `#rrggbb`, plus its suggestion's name) and its values, the document URL of exactly that variant, and the
  `screenshot.ts --path …` line that renders it. Read-only.
- `prototype log <id> [-p]` — versions newest first, with each request and
  agent summary; `-p` adds each version's diff.
- `prototype checkpoint <id> [-m <msg>]` — record a `manual` version now.
- `prototype restore <id> <vN|sha>` — the pane's Restore button.

**All of them work with no backend running, and that is the point of having them.** The
prototypes tree is host-global and outside every checkout, so `new` calls
`mintPrototype()` straight against the filesystem rather than
`POST /api/prototypes`, and `list` calls `listPrototypeMetas()` rather than
fetching `GET /api/prototypes`. Neither verb has an implementation of its own:
the endpoint and the CLI share the mint, and the list endpoint, the
`prototypes.list` resource and `prototype list` share the lister — so a terminal
answer can never disagree with the gallery.

That sharing is what moved the lister. `listPrototypeMetas()` now lives in
`shared/list-metas.ts`; `server/internal/list.ts` re-exports it, so
`handlers.ts`, `resources.ts` and the server barrel (which `thumbnails` reads it
from) are untouched. Nothing in it was ever server-specific — it reads the data
dir and parses HTML — and `shared/` is where this plugin already keeps the code
a CLI process and the server both run (`read-folder.ts`, `mint.ts`,
`template.ts`).

`cli/index.ts` is the DECLARATION and is loaded on every single `./singularity`
invocation, `build` included, because commander needs the names and flags before
it parses argv. It therefore imports `defineCliCommand` and nothing else; every
body sits behind `run: () => import("./<verb>")`.
`cli:command-declarations-light` fails the declaration if its static closure
reaches an npm package or a `web`/`server` barrel.

`cli/prototype-url.ts` builds
`http://<namespace>.localhost:9000/prototypes/proto/<id>` from parts rather than
by hand: the namespace is minted with `checkoutNamespace(root)` off the CHECKOUT
(a CLI process declares no runtime namespace at all, so asking for one throws),
`.localhost:9000` comes from
`namespaceUrl`, and `/prototypes` from `prototypesApp.basePath`. The one literal
is the detail pane's own `proto/:name/:stage?` segment — it is declared in
`gallery/web`, which a terminal verb must not import. The same origin prefixes
`prototype options`' document URL, which comes from `prototypeUrl()` — the
builder the frames use — so the terminal and the pane name a variant alike.

## The contract this serves

A prototype is one folder holding a **self-contained `index.html`** plus
whatever flat files it references. Nothing is shared: there is no
`prototypes/_shared/`, no harness, and no `meta.json`. The invariant that
defines it — double-clicking `prototypes/<name>/index.html` in Finder opens and
renders it. If it only works through this API, it isn't self-contained.

Metadata is therefore read out of the HTML, not a sidecar file:

- `<title>` → `title` (default: `UNTITLED_PROTOTYPE`, never the directory
  name — that is an opaque id)
- `<meta name="description">` → `blurb` (default: `""`)
- `<meta name="prototype-viewport" content="window">` → `viewport`: `responsive`
  (fills the room it is given — the default), `window` (the viewer's own
  browser window) or a size preset's name (`phone`, `tablet`, `laptop`,
  `desktop`, `wide`). Where
  there is no viewer's window (thumbnails, Compare), `window` and `responsive`
  render at `HEADLESS_PRESET` (Laptop). `core/viewport.ts` owns the presets
  (`SIZE_PRESETS`, which the canvas's size menu lists) and the parser
  (`parseViewport`); anything else — the retired `WxH` form included — is a
  `problems[]` entry and reads as the default. Named, not pixels, because the
  free `WxH` was an arbitrary number per prototype that matched no preset.
- `<meta name="mocks" content="<kind>:<ref>">` → `mocks` (default: `{ kind: "none" }`)
- every `<meta name="prototype-option" content="<name>: <v> | <v>">` (a
  choice, its default read off `<html data-<name>>`) or `content="<name>: color
  <s>=<color> | …"` (a color, its default read off the `--<name>` custom
  property in `<html style>`) → `options` (default: `[]`)

`mocks` is the real app thing this prototype is a mockup OF — the pairing the
canvas's Real app frame reads: `exhibit:task-draft/composer` (one real component
from the exhibit catalog), `route:/agents/c/123` (the running app at a path). `core/mocks.ts`
parses it (`parseMocks`, pinned by `mocks.test.ts`) into a three-way value on
the wire: `none`, `malformed { raw, reason }`, or `declared { tag, ref }` — split
at the FIRST colon, so a ref may carry its own.

Syntax is all that is judged here. The kind set is open (each kind is a web
plugin contributed into the compare plugin's registry) and the ref is resolved
only there — exhibits and panes are per-worktree code while prototypes are
host-global and outside git, so the pairing can only ever be a runtime lookup,
and a prototype naming a kind or a ref this worktree does not have is a thing
that surface renders, not a problem with the folder.

Absent is the ordinary answer — most prototypes mock nothing — and is never a
`problems[]` entry. A **malformed** line IS one (`validatePrototypeFolder`,
wording from `mocksProblemDetail`): the bare legacy form `control-panel/…` with
no `<kind>:` prefix, an empty half, a kind that is not lowercase letters, digits
and dashes. It surfaces on the card and the canvas's problem banner, where the author is
looking, and the Real app frame repeats it beside the syntax.

`options` are the variants a reader flips between (the contract is in
`prototypes/CLAUDE.md` § Options). `core/options.ts` is pure (parse, fold,
resolve picks, query → picks; pinned by `options.test.ts`);
`core/option-source.ts` is the ONE HTML read of the declaration (the `<meta>`
lines, `<html>`'s `data-*` and the custom properties of its `style`), shared by
the list, `validatePrototypeFolder` and the server's stamping so they cannot
disagree. The default lives on `<html>` — not "the first value" — so the page
carries it in every context (off disk, thumbnail, app) and the app only ever
overwrites it. A line that cannot be an option is dropped from `options` and
reported in `problems[]`.

`PrototypeOption` is a union on `kind` (the wire `PrototypeOptionSchema` is the
matching discriminated union, also carried by `PrototypeVersion.options`):

- **`choice`** — `values` (2+, distinct) and `default` (one of them, from
  `data-<name>`). A pick is one of the values.
- **`color`** — after the colon a leading `color` keyword (`mode: color |
  mono` stays a choice: the keyword is never followed by `|`), then 0..n
  `name=<css color>` `suggestions`, each normalised to lowercase `#rrggbb` by
  the color picker's own parser (`Color.fromCss`, from
  `primitives/css/color-picker/core`; translucent colors refused,
  `parseOptionColor`). `default` is the `--<name>` property in `<html style>`,
  as `#rrggbb`. A pick is a suggestion's name or a lowercase `#rrggbb` —
  readable by agents, URL-safe as `%23rrggbb`; `colorPickValue` names a color
  that lands on a suggestion by that suggestion. `pickedColor(option, picks)`
  is the hex on screen; `pickedValue` is the value (for an unpicked color: the
  default's suggestion, else its hex). `resolvePicks` drops a color pick whose
  color IS the default, like a choice's default value. Problems: no `--<name>`
  (with a hint when a `data-<name>` was written instead), a default or
  suggestion that is not an opaque color, a duplicate suggestion name.

Parsed with `HTMLRewriter`; every value it yields is decoded once via
`@plugins/infra/plugins/html-decode/core` — the rewriter decodes nothing.

Design: `research/2026-08-15-global-prototypes-self-contained.md`.

## Routes

- `GET /api/prototypes` → `PrototypeMeta[]` (every `prototypes/<name>/index.html`,
  skipping `_`-prefixed and dot-dirs; the dir name is the `name`). JSON, so it
  goes through `implement()`.
- `POST /api/prototypes` → `{ id }`, body `{ title? }`. Mints a folder from the
  template. JSON, so it goes through `implement()` too.
- `GET /api/prototypes/:name` → **302** to `…/:name/index.html`, carrying the
  query across. Only for hand-typed URLs; nothing in the app links here.
- `GET /api/prototypes/:name/:file` → `prototypes/<name>/<file>` verbatim,
  Content-Type by extension, `Cache-Control: no-store`. Raw handler (custom
  Content-Type, per-file bytes). Path-traversal-guarded to stay under
  `prototypes/`; 400 on escape, 404 on missing. **Except** `index.html` asked
  for with option picks (`?palette=azure`, any key but `v`): the picks are
  checked against the page's own declaration and stamped onto `<html>` — a
  choice as `data-*`, a color as `--<name>: #rrggbb` merged into its `style`
  (any earlier declaration of that property dropped, the rest kept; edited
  decoded and escaped again by `setAttribute`) — the one HTMLRewriter *rewrite* in the repo (every other use only
  extracts). An undeclared name or value is a **400** rendered in the frame: a
  broken variant link must say so, not quietly show the default. The file is
  read whole first because `<html>` streams before the `<meta>` tags that say
  what is valid. With no picks the file streams through untouched.

**Why the extra path segment.** Serving the document at `<name>/index.html`
rather than at `<name>` is what makes a relative `href="styles.css"` inside it
resolve to `/api/prototypes/<name>/styles.css` — the same relative reference
that works off `file://`.

**Why `no-store`.** The version query cache-busts only the document; without it
the browser keeps the old `styles.css` and an edit looks like it didn't land.

- `GET /api/prototypes/:name/versions/:sha/:file` → that file as recorded in
  that version, read out of git; `Cache-Control: immutable` (the sha addresses
  the content); 404 for anything that does not name a version's file. A path
  prefix per version, so its relative `styles.css` resolves to the same version.
  Its `index.html` takes option picks exactly like the live route (same
  `server/internal/picked-document.ts`), judged against the options THAT
  version declares. Built by `prototypeVersionUrl(name, sha, { picks })`.
- `POST /api/prototypes/:name/versions/:sha/restore` → the new `restore`
  version (`restorePrototypeVersion`, via `implement()`).
- `PUT /api/prototypes/:name/picks` → 204, body `{ kind: "set", option, value }`
  or `{ kind: "reset" }` (`setPrototypePicks`); 404 for an unknown prototype.

Each `:param` matches exactly one segment and the router has no wildcard, so a
prototype folder is flat by construction — `<name>/assets/x.svg` is unserveable.
The router matches on the segment count, so the six-segment version routes
never compete with the four-segment file route.

## Live state

Every one is a `liveValue` declared in `core/` and served in `server/internal/`
by `serveValue(…, { source: "external" })` — the truth is the data dir, not
Postgres — whose `notify` the watcher (and a PUT, for its own write) calls. The
server barrel spreads each served value's `declare` into `contributions`. None
has a placeholder: until the server answers, a read is `pending`, never an empty
list or an empty history.

- `prototypes.list` (`prototypesList` / `prototypesListServed`,
  `resources.ts`) — the prototype list (push). Each `PrototypeMeta.rev` is a
  short hash of that folder's signature (`shared/folder-signature.ts`); a live
  frame's `src` carries it as `?v=`, so an agent's edit reloads exactly that
  prototype's frames. Derived from the bytes on disk, it survives a backend
  restart unchanged — there is no global, process-born version that would
  reload every open frame on each redeploy or on another prototype's edit.
- `prototypes.history` (`prototypeHistory` / `prototypeHistoryServed`,
  `history.ts`) — one prototype's versions + `dirty` (push, a value per
  `name`); see Version history.
- `prototypes.picks` (`prototypePicks` / `prototypePicksServed`, `picks.ts`) —
  one prototype's stored option picks (push, a value per `name`); see Option
  picks.
- `prototypes.statuses` (`prototypeStatuses` / `prototypeStatusesServed`,
  `status.ts`) — every recorded Done status, keyed by id (push); see Status.

`onReady` starts the `prototypesTreeWatcher` declaration (`defineFileWatcher`) over `prototypes/`, watching every
extension a prototype can ship (`.html/.css/.js/.json` plus images and
`.woff2`); `onShutdown` stops it. No polling.

**Nothing re-broadcasts unless the tree really moved.** Every wake-up — a
watcher event, the 30s reconcile — runs the same gate: re-read
`readPrototypesSignature()` (every file's size + mtime) and return early when it
matches the last one. A moved `rev` is a RELOAD of that prototype's open iframes,
and a prototype is a live app somebody is clicking through, so a reload costs
the author the state they built up on screen. A watcher event only says
something *might* have changed (a touch, a chmod, an atomic save's temp file),
which is not enough of a reason.

That gate is also why the reconcile is affordable at all: it is a backstop for
an fsevent parcel dropped, and on an idle machine it is a few stats that agree
with the last few stats and end there.

**This is the only watcher over that tree, so the signal is exported rather than
re-derived**: `onPrototypesChanged` (plus `listPrototypeMetas`) is what lets
`thumbnails` react to an edit without a second `@parcel/watcher` subscription
doubling every filesystem event.

## The check

`check/index.ts` contributes `prototypes:self-contained` — the machine-checkable
half. Fails on: no `index.html`, no non-empty `<title>`, a subdirectory, a
leftover `meta.json`, a file referencing `_shared`, `../`, or another
prototype's folder, and `<script type="text/babel" src="…">`.

That last one is the trap worth knowing: Babel-standalone fetches a `src` with
XHR, Chrome blocks file→file XHR, so an external `.jsx` works perfectly through
this server and renders nothing on double-click. JSX goes inline. (A plain
`<script src="fixtures.js">` is an ordinary script load and is fine.)

`_template/` is checked the same way (the template must itself be self-contained)
but its name is not a forbidden reference target. The check catches copied
*files*, never copied *design*.

The `core` barrel exports the shared contracts the web consumes: `PrototypeMeta`,
the live values `prototypesList` / `prototypeHistory` /
`prototypePicks` / `prototypeStatuses` (`liveValue` declarations, read with
`useLive`), `prototypeUrl()` /
`prototypeVersionUrl()`, the `listPrototypes` / `createPrototype` /
`restorePrototypeVersion` / `setPrototypePicks` endpoints, the picks shapes
(`StoredPicks`, `PicksChange`, `applyPicksChange`), the version shapes
(`PrototypeVersion`, `PrototypeHistory`), and the id kind (`protoIdKind`,
plus `prototypeIdsIn`). The server barrel adds `checkpointPrototype`
for the `checkpoints` plugin's end-of-turn job.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Registers the prototype id kind (`proto-…`) in the browser's id-kind registry. Serves raw prototype files from the host-global prototypes data dir (the `apps/prototypes` declaration — shared by every worktree and main, so a mock is visible without a build and without being committed), mints new prototypes into it from the running checkout's prototypes/_template/, declares the list + version live-state resources, watches the dir to auto-reload open iframes on edit, stamps a document's picked options (?<option>=<value>) onto its <html> (data-* for a choice, a --<name> custom property for a color), stores the user's option picks as one shared record per prototype under _picks/ (the prototypes.picks resource and its PUT, undone for automated sessions through the agent-write ledger), stores whether the user marked each prototype Done or pinned it as one shared record under _status/ (the prototypes.statuses resource and its PUT, undone the same way), and keeps each prototype's version history (a private git repo per prototype under _history/: the per-prototype history resource, a version's files, restore, and checkpointPrototype).
- Web:
  - Contributes: `IdKinds.Kind` "proto"
  - Uses: `ids.IdKinds`
- Server:
  - Contributes:
    - `ids.kind` "proto"
    - `resource.declare` "prototypes.history"
    - `resource.declare` "prototypes.list"
    - `resource.declare` "prototypes.picks"
    - `resource.declare` "prototypes.statuses"
  - Uses:
    - `ids.IdKinds`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/file-watcher.defineFileWatcher`
    - `infra/file-watcher.FileWatcher`
    - `infra/request-origin/agent-write-ledger.defineAgentWriteLedger`
    - `network/live.serveValue`
  - Exports (values):
    - `checkpointPrototype`
    - `listPrototypeMetas`
    - `onPrototypesChanged`
    - `readPrototypeTitle`
  - Register: `defineFileWatcher('prototypes-files.tree')`
  - Resources:
    - `prototypes.history` (push, notified)
    - `prototypes.list` (push, notified)
    - `prototypes.picks` (push, notified)
    - `prototypes.statuses` (push, notified)
  - Routes:
    - `GET /api/prototypes`
    - `POST /api/prototypes`
    - `POST /api/prototypes/:name/versions/:sha/restore`
    - `PUT /api/prototypes/:name/picks`
    - `PUT /api/prototypes/:name/status`
- Core:
  - Uses:
    - `ids.defineIdKind`
    - `infra/endpoints.defineEndpoint`
    - `infra/html-decode.decodeHtmlText`
    - `infra/html-decode.readHtmlAttr`
    - `network/live.liveValue`
    - `primitives/css/color-picker.Color`
  - Exports (types):
    - `ChoiceOption`
    - `ColorOption`
    - `ColorSuggestion`
    - `MocksDeclaration`
    - `OptionDeclaration`
    - `OptionPicks`
    - `OptionSource`
    - `PicksChange`
    - `PresetName`
    - `PrototypeFolder`
    - `PrototypeHistory`
    - `PrototypeMeta`
    - `PrototypeOption`
    - `PrototypeProblem`
    - `PrototypeStatus`
    - `PrototypeStatusChange`
    - `PrototypeVersion`
    - `PrototypeVersionKind`
    - `PrototypeViewport`
    - `StoredPicks`
  - Exports (values):
    - `applyPicksChange`
    - `applyPrototypeStatusChange`
    - `colorPickValue`
    - `createPrototype`
    - `DEFAULT_PROTOTYPE_VIEWPORT`
    - `describeOptionValues`
    - `foldOptions`
    - `HEADLESS_PRESET`
    - `humanizeToken`
    - `isHexColor`
    - `isOptionName`
    - `isOptionValue`
    - `isScannableFile`
    - `listPrototypes`
    - `MocksDeclarationSchema`
    - `mocksProblemDetail`
    - `NO_PROTOTYPE_STATUS`
    - `parseMocks`
    - `parseOptionColor`
    - `parseOptionDeclaration`
    - `parseViewport`
    - `pickedColor`
    - `pickedValue`
    - `PicksChangeSchema`
    - `picksFromQuery`
    - `presetSize`
    - `protoIdKind`
    - `PROTOTYPE_ASSET_ROUTE`
    - `PROTOTYPE_ENTRY_FILE`
    - `PROTOTYPE_FILE_ROUTE`
    - `PROTOTYPE_VERSION_FILE_ROUTE`
    - `PROTOTYPE_VERSION_KINDS`
    - `PROTOTYPE_VIEWPORT_WORDS`
    - `prototypeHistory`
    - `PrototypeHistorySchema`
    - `prototypeIdsIn`
    - `PrototypeMetaSchema`
    - `PrototypeOptionSchema`
    - `prototypePicks`
    - `PrototypeProblemSchema`
    - `PROTOTYPES_API_BASE`
    - `prototypesList`
    - `PrototypeStatusChangeSchema`
    - `prototypeStatuses`
    - `PrototypeStatusSchema`
    - `prototypeUrl`
    - `PrototypeVersionSchema`
    - `prototypeVersionUrl`
    - `PrototypeViewportSchema`
    - `readOptionSource`
    - `readPrototypeOptions`
    - `resolvePicks`
    - `restorePrototypeVersion`
    - `setPrototypePicks`
    - `setPrototypeStatus`
    - `SIZE_PRESETS`
    - `statusOf`
    - `StoredPicksSchema`
    - `UNTITLED_PROTOTYPE`
    - `validatePrototypeFolder`
    - `viewportProblemDetail`
    - `viewportRenderSize`
    - `viewportWord`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by:
    - `active-data/prototype`
    - `apps/prototypes/canvas`
    - `apps/prototypes/checkpoints`
    - `apps/prototypes/thumbnails`

<!-- AUTOGENERATED:END -->
