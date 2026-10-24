# Prototypes get an id, and a mint that hands it out

## Context

A prototype is identified today by the name an agent invented for its folder
(`ember`, `helix`, `improve-quiet`). That name is the only handle it has:
`PrototypeMeta.name` IS the directory name (`files/server/internal/list.ts:111`),
it is the URL segment, and it is what the "Improve this prototype" prompt hands
the agent.

Two things follow from having no id:

- **A prototype cannot be referenced.** An agent that has just built a mock has
  no token it can write in a message that the app understands. Every other
  entity here does: `att-…`, `conv-…`, `task-…`, `block-…` each render as a
  clickable chip through an `active-data` inline contribution, so the thing
  being discussed is one click from the transcript. A prototype — the one entity
  whose whole value is *being looked at* — is the exception.
- **Nothing mints it.** A prototype folder is created by an agent running
  `cp -R _template <name>` (`prototypes/CLAUDE.md`), which means the naming, the
  flat-folder rule and the copy are all the agent's to get right, and there is no
  server write path at all (`files/server/index.ts` registers three `GET`s and
  nothing else).

**Outcome:** a prototype's folder name becomes an opaque minted id
(`proto-<epoch>-<4char>`), one function mints it, three surfaces call that
function, and a bare id written anywhere active-data renders becomes a chip that
opens the mock beside the text.

### Why the folder name, and why opaque

The id and the directory name are the same string. The alternative — a stable id
inside `index.html` with a free-form folder name — buys a readable `ls` and
costs two failure modes that a single identity cannot have: an agent rewriting
`index.html` wholesale drops the id, and copying a folder duplicates it. It also
puts a dir↔id map in front of every consumer (routes, watcher, thumbnail state,
backup). With the folder name as the id, the mint is `mkdir` and the filesystem
is the uniqueness authority.

Opaque rather than a slug because **the name is not known when the folder is
minted**. The gallery's New-prototype flow creates the folder before the agent
runs, so any slug chosen there is a guess; and renaming it later to the real name
would change the id, which is the one thing an id exists to prevent.

Nothing is lost to a human: all nine existing prototypes already carry a real
`<title>`, and the gallery card, the Compare captions and the DataView label all
read `meta.title` today, not the folder name. Only two surfaces show the raw
name, and one of them is fixed below.

## The id

`proto-<epochSeconds>-<4 base36 chars>` — the shape `newId()` already mints for
attempts and conversations (`conversations/server/internal/lifecycle.ts:61-64`),
so `PROTOTYPE_ID_RE` is `/proto-\d+-[a-z0-9]{4}/`, byte-for-byte the shape of
`ATTEMPT_ID_RE`.

New file **`files/core/id.ts`**, re-exported from `files/core/index.ts`:

```ts
export function newPrototypeId(): string
export const PROTOTYPE_ID_RE: RegExp   // unanchored core shape, no /g
export function isPrototypeId(name: string): boolean
```

**One spelling of the format.** The mint, the folder-name validation and the chip
pattern all read `PROTOTYPE_ID_RE` from here. This is a deliberate improvement on
the `att-`/`block-` precedent, where the chip re-types the shape and a mint
change silently switches the chips off — `page-link`'s docblock says as much. A
`bun:test` beside it pins `newPrototypeId()` against both the core regex and the
chip's boundary-wrapped pattern, so the two cannot drift.

## The mint

New file **`files/shared/mint.ts`** — `shared/`, not `core/`, because it touches
`node:fs`, and not `server/`, because the CLI calls it too. `shared/read-folder.ts`
is the existing precedent for exactly this (it is imported by `check/index.ts`).

```ts
export async function mintPrototype(opts?: { title?: string }): Promise<{ id: string; dir: string }>
```

It copies the seeded `_template/` into a freshly minted id, then stamps `<title>`
when one was given. **Reuse the body of `files/server/internal/seed.ts`** — it is
already the exact primitive: `mkdtemp` staging → `cp(..., {recursive:true})` →
`rename(staging, dest)`, with the `EEXIST`/`ENOTEMPTY` arm treated as "someone
else won the race". Lift that copy into `shared/` as one helper and have both
`seedTemplate()` and `mintPrototype()` call it; a name collision (astronomically
unlikely, but free to handle) re-mints rather than throwing.

The template source is `prototypesDir.file("_template")` — the *seeded* copy, not
the repo's, so the mint works in a compiled release. If it is absent (fresh host
whose backend has never booted), seed it first from the checkout. Note for the
implementer: `server/internal/paths.ts` reaches the repo via `REPO_ROOT` from
`paths/server`, which `shared/` must not import; `check/index.ts` in this same
plugin uses `getWorktreeRoot()` from `@plugins/infra/plugins/spawn/core` for the
same job — use that.

### Surface 1 — the gallery, before it launches

`POST /api/prototypes`, declared with `defineEndpoint` beside the existing
`listPrototypes` in `files/core/prototypes.ts` (raw JSON handlers are banned),
body `{ title?: string }`, response `{ id: string }`. Implemented in
`files/server/internal/handlers.ts`, registered in `files/server/index.ts`.

In `gallery/web/components/prototype-gallery.tsx`, `getRequest` is already typed
`(userText: string) => LaunchRequest | Promise<LaunchRequest>`
(`launch/web/components/launch-agent-popover.tsx:17`) and is already awaited
before the conversation is created (`launch-control.tsx:89`). So it mints, then
returns a prompt naming the folder. No change to `LaunchAgentPopover`,
`createConversation`, or the conversations plugin.

`NEW_PROTOTYPE_TEXT` is rewritten around that: the agent is told its folder
already exists at `~/.singularity/apps/prototypes/<id>/`, holding the blank
template, and to edit in place. **The "copy `_template/`, pick a slug"
instruction disappears from this path** — the agent is never asked to name
anything, so it cannot name it wrong. The "do not open another prototype's
folder / do not read `plugins/`" half stays verbatim.

Consequence to accept: a card appears in the gallery the moment New prototype is
clicked, reading "Untitled prototype" (the template's own `<title>`) until the
agent writes. That is honest — the prototype does exist — and it self-corrects on
the agent's first save.

### Surface 2 — `./equin prototype`

New **`files/cli/index.ts`**, picked up by the `cli` collected dir with no
registry edit (`framework/plugins/cli/core/collected-dir.ts`). A group with two
leaves, shaped like the existing `db` group
(`framework/plugins/cli/plugins/db/cli/index.ts`):

- `prototype new [title]` — mint, stamp `<title>` if given, print the id, the
  folder path and `http://<namespace>.localhost:9000/prototypes/proto/<id>`.
- `prototype list` — id, title and URL for every prototype.

The declaration imports only `defineCliCommand` from
`@plugins/framework/plugins/cli/core`; both implementations sit behind
`run: () => import("./new")` / `import("./list")`. This is enforced —
`cli:command-declarations-light` fails a declaration whose static closure reaches
an npm package or a `web`/`server` barrel.

The implementations call `mintPrototype()` / `listPrototypeMetas()`-equivalent
directly against the filesystem, not over HTTP: the CLI's value here is working
with no backend running.

### Surface 3 — a folder that was not minted

`validatePrototypeFolder` (`files/core/validate.ts`) gains one problem: a
directory name that is not a valid prototype id. It rides the existing
`problems[]` onto the gallery card, next to the flat-folder and missing-`<title>`
problems, with a detail naming `./equin prototype new` as the fix.

It must skip `_`-prefixed directories — `check/index.ts:91` runs this same
function over `_template` with `dirName: "_template"`, so an unguarded rule
fails the repo check on the seed itself.

Deliberately a *problem*, not a refusal: prototypes are user content, and a
hand-made folder must keep working and keep being served. This is the loud-runtime
rung, and it is what stops `cp -R _template` from being silently fine again.

## The chip

New plugin **`plugins/active-data/plugins/prototype/`**, mirroring
`active-data/plugins/page-link/` file for file:

- `web/internal/pattern.ts` — `inlineBoundary(PROTOTYPE_ID_RE)`, the id shape
  imported from `files/core` rather than re-typed.
- `web/internal/pattern.test.ts` — the mint-driven pin described above.
- `web/components/prototype-chip.tsx` — `useResource(prototypesResource)` +
  `matchResource`; the resource is already live, app-wide and pushed on every
  file change, so resolution costs no request.
- `web/index.ts` — one `ActiveData.Tag({ display: "inline", … })` contribution.

Resolved, it renders a `LinkChip` labelled with the prototype's `<title>` and
opens `prototypeDetailPane` with `{ mode: "push" }`, so the mock appears as a
live column beside the conversation
(`/agents/c/<convId>/proto/proto-…`). Cross-app push is exactly what `page-link`
already does into the Pages app.

Unresolved or still pending, it renders the raw id as plain text — `page-link`'s
behaviour, not `attempt`'s: with an opaque id there is nothing useful to show, and
a chip that opens nothing is worse than the text the model wrote. (Making
`prototypesResource` `resident: true` would remove the pending window entirely,
but it would pull a niche app's list into every app's boot snapshot; not worth it
for a brief flash of the raw id.)

Verify no import cycle: this plugin reaches `files/core` and `gallery/web`, and
neither may reach `active-data`.

## Two small display fixes that the opaque id forces

- `gallery/web/components/prototype-detail.tsx:36` passes `title={name}` to
  `PaneChrome`. It must pass the resolved `meta.title` — otherwise the detail
  pane header reads `proto-1787215770-3i6v`. This is the only place a user would
  see the raw id.
- `scaled-iframe.tsx:68` defaults the iframe's `title` attribute to `meta.name`;
  same fix, for screen readers.

The route segment stays `proto/:name`. `/prototypes/proto/proto-…` looks
redundant, but it is exactly the shape `/agents/c/conv-…` already has, and
changing it churns URLs for nothing.

## Migration — the nine existing prototypes, by hand

Renamed each folder to a freshly minted id, using the folder's own mtime as the
epoch so the ids stay chronologically truthful. **Done — this is the record:**

| was | is now | `<title>` |
|---|---|---|
| `ember` | `proto-1786877040-w2vi` | Ember — agent conversation |
| `helix` | `proto-1786877040-8tv7` | Helix |
| `mist-panes` | `proto-1786877040-3k6f` | Mist panes |
| `improve-anchored` | `proto-1786908009-algp` | Improve — anchored popover |
| `improve-briefing` | `proto-1786908009-2re5` | Improve — briefing rail |
| `improve-quiet` | `proto-1786908009-rgy6` | Improve — quiet composer |
| `control-panel-vocabulary` | `proto-1786965720-op2v` | Control panel vocabulary |
| `sketch-roll` | `proto-1787083342-tbpa` | Sketch roll |
| `control-panel-studies` | `proto-1787099864-wlwr` | Control panel studies |

Checked before renaming: no prototype references another's folder at a path
position, so nothing broke. Two prototypes mention their OWN old name — `ember`
as a CSS variable (`--ember`), `helix` as a theme class (`.theme-helix`) plus one
stale comment pointing at `helix/app.jsx`. Those are inside throwaway user
content and were left alone.

Every one already has a real `<title>`, so no gallery card changes what it says.
Thumbnails survive for free: the PNG cache is keyed by a content hash
(`thumbnails/server/internal/hash-dir.ts`), and the name-keyed state map is
rebuilt wholesale on every reconcile — a renamed folder hits the same cached PNG
immediately. The backup source copies the whole tree and keys on nothing.

**Two consequences worth stating.** The prototypes dir is host-global, so the
rename lands on main's live gallery immediately, before any of this code merges —
harmless, because today's code reads whatever directories exist and displays
their titles, but any Focus URL someone has open will 404 until reloaded. And it
is user content, so `git revert` does not undo it; the table above is the record.

## Docs

- `prototypes/CLAUDE.md` — the authoring contract every prototype agent reads.
  The `cp -R ~/.singularity/apps/prototypes/_template <name>` gesture becomes
  `./equin prototype new`, and the folder-name section says the name is a
  minted id, not a slug to choose.
- `plugins/apps/plugins/prototypes/CLAUDE.md`, `…/files/CLAUDE.md`,
  `…/gallery/CLAUDE.md` — the mint, the endpoint, the CLI verb, the id.
- A `CLAUDE.md` for each new plugin folder.
- This doc, referenced from the files plugin's CLAUDE.md.

## Verification

1. `./equin test plugins/active-data/plugins/prototype` — the pattern pin.
2. `./equin build`, then:
   - `./equin prototype new "Smoke test"` prints an id; `prototype list`
     shows it; the card appears in the gallery with no rebuild.
   - `mkdir ~/.singularity/apps/prototypes/not-minted` and confirm its card
     carries the "not a minted id" problem while still rendering.
   - Delete both afterwards.
3. Click **New prototype** in the gallery: a card appears immediately, and the
   launched conversation's first turn names the minted folder.
4. `bun plugins/active-data/plugins/prototype/e2e/prototype-chip-verify.ts --conv <id>`,
   mirroring `page-link/e2e/page-link-verify.ts`: locate the chip by
   `button[title*="<id>"]`, assert its label is the title and not the raw id,
   click it, assert the URL gained `/proto/<id>` and the conversation column
   stayed open.
5. `./equin check` — `prototypes:self-contained` (the `_template` skip),
   `cli:command-declarations-light` (the new declaration), `plugins-doc-in-sync`,
   `plugins-registry-in-sync`.
6. `query_db` is not involved: prototypes have no rows.
