# Prototypes: one self-contained `index.html`, nothing shared

Supersedes the shared-harness design in
[`2026-06-16-global-prototypes-design-workflow.md`](./2026-06-16-global-prototypes-design-workflow.md).
That doc's app surface (gallery / Focus / Compare / push-reload) stands; its
prototype *file contract* is what changes here.

## Context

Prototypes exist so an agent can explore a UI idea from scratch. Today the
directory works against that, because everything an agent needs is expressed
through files that already contain someone else's design decisions:

- **`_shared/tokens.css`** is not, as the original doc claimed, a snapshot of the
  real app's tokens. It is the two existing prototypes' palettes verbatim,
  `.theme-helix` (cream / terracotta) and `.theme-mist` (slate / teal) — and
  `meta.json` has a required `theme` field selecting one. A new prototype is
  *required to start from an existing design*.
- **`_shared/harness.html`** preloads four fonts for everyone. Typography is
  decided before the agent begins.
- **`_shared/fixtures.js`** encodes a rendering decision, not just data: event
  titles are arrays of typed segments (`{text}` / `{path}` / `{hash}` /
  `{faint}`) that presume paths and commit hashes are highlighted inline.
- **The gallery's own "New prototype" button** seeds the agent's prompt with
  *"following the shape of the existing mocks"* — the product instructs agents
  to go read siblings.

Alongside that, `meta.json` + `harness.js` (125 lines) are a hand-rolled `<head>`
and script loader: `styles` is `<link>`, `scripts` is `<script>`, `theme` is a
class attribute, `viewport` is a width and height. All of it exists only because
a prototype isn't an HTML file. It also forces every prototype to be a
full-screen React app defining `window.App` — a single button design can't be
expressed.

**Outcome:** a prototype becomes one folder holding a self-contained
`index.html`. Nothing is shared, so there is no house style to inherit and
nothing an agent must read before starting. That also makes the later isolation
step cheap: once nothing is shared, hiding sibling prototypes costs nothing.

## The new contract

```
prototypes/
  CLAUDE.md              # the authoring contract + the no-siblings rule
  _template/
    index.html           # design-less skeleton, copied to start a new prototype
  <name>/
    index.html           # the only required file
    styles.css           # optional, referenced relatively
    app.jsx  fixtures.js # optional, whatever this prototype needs
```

- **Flat folders.** No subdirectories — the HTTP router matches an exact segment
  count and has no wildcard, so `<name>/assets/x.svg` cannot be served.
- **Metadata comes from the HTML**, no `meta.json`:
  - `<title>` → the gallery card's name (falls back to the directory name)
  - `<meta name="description">` → the card blurb
  - `<meta name="prototype-viewport" content="1320x868">` → the Focus/Compare
    canvas size, **optional**, defaulting to `1280x800`
- **The invariant that defines self-contained:** double-clicking
  `prototypes/<name>/index.html` opens and renders it. If it only works through
  our API, it isn't self-contained.
- Directories starting with `_` or `.` are not prototypes.

## Work

### 1. `prototypes/` content

**`prototypes/_template/index.html`** — one file, deliberately design-less: no
color, system font, unstyled boxes, a `<title>`/`<meta description>` to fill in,
and a commented-out block of React/Babel CDN tags to uncomment if wanted. It
teaches structure and zero aesthetics.

**Migrate `helix/` and `mist-panes/`**, each to the new shape:

1. New `index.html` per prototype containing what the harness used to supply on
   its behalf: its own font `<link>`, the reset from `harness.html`'s inline
   `<style>` (`box-sizing`, `margin/padding: 0`, `height: 100%`), `<div
   id="root">`, its own CDN `<script>` tags, one `<script type="text/babel"
   src="…">` per entry of the old `meta.scripts` **in the same order**, then a
   final inline `<script type="text/babel">` mounting `window.App` into `#root`.
   Keep the old `meta.theme` value as a class on `<body>` (`class="theme-helix"`)
   so the existing `.theme-helix …` selectors in its CSS keep matching.
2. Copy that prototype's palette block out of `_shared/tokens.css` into its own
   `styles.css`, plus the `:root` font variables it uses. Move the old
   `meta.viewport` sizing of `#root` into its own CSS.
3. Copy `_shared/fixtures.js` into `<name>/fixtures.js`.
4. Delete `prototypes/_shared/` and both `meta.json` files.

**Risk to verify first:** `@babel/standalone` must fetch, transform and run
`<script type="text/babel" src="…">` tags in document order. If ordering proves
unreliable, fall back to a single inline `<script type="text/babel">` per
prototype. Check this before migrating both.

### 2. Server — `plugins/apps/plugins/prototypes/plugins/files/`

- **`core/prototypes.ts`** — `PrototypeMetaSchema` becomes
  `{ name, title, blurb, viewport: { w, h } }`; drop `theme`, `scripts`,
  `styles`. Add `PROTOTYPE_ASSET_ROUTE = "GET /api/prototypes/:name/:file"`.
  `prototypeUrl(name, { v })` now builds
  `/api/prototypes/<name>/index.html?v=<version>` — the extra path segment is
  what makes a relative `href="styles.css"` inside the file resolve correctly.
- **`server/internal/handlers.ts`** — delete `HARNESS_PATH` and the harness
  branch. Bare `GET /api/prototypes/:name` becomes a 302 to
  `…/:name/index.html` (preserving `?v=`), so a typed URL still works. Add
  `handlePrototypeAsset` serving `resolvePrototypeFile(name, file)` (traversal
  guard unchanged) with `contentTypeForPath(file)` and `Cache-Control:
  no-store` — without that, sub-resources stay cached and the auto-reload only
  refreshes the document.
- **`server/internal/paths.ts`** — extend `MIME_BY_EXT` with `.svg`, `.png`,
  `.jpg`, `.webp`, `.gif`, `.woff2` so a prototype can ship its own assets.
- **`server/internal/list.ts`** — discover by `index.html` instead of
  `meta.json`; skip `_`/`.` prefixed dirs. Parse the HTML with `HTMLRewriter`
  for `<title>` and the two `<meta>` tags, decoding with `decodeHtmlText` /
  `readHtmlAttr` from `@plugins/infra/plugins/html-decode/server` (that plugin
  exists precisely because HTMLRewriter decodes nothing). Defaults: title → dir
  name, blurb → `""`, viewport → `1280x800`.
- **`server/internal/watcher.ts`** — add `.js` and the image extensions to the
  watched set. It currently watches only `.jsx/.css/.html/.json`, so a
  prototype's own `fixtures.js` edit would not trigger a reload.

### 3. Gallery — `plugins/apps/plugins/prototypes/plugins/gallery/web/`

- `prototype-gallery.tsx` — drop the `theme` field and seed `hueFor()` from
  `name`; show `title` on the card. `scaled-iframe.tsx` and the Compare grid
  need no change once `viewport` is always populated by the server default.
- **Rewrite the two launch prompts** — `NEW_PROTOTYPE_TEXT` in
  `prototype-gallery.tsx` and `improveText()` in `prototype-detail.tsx`. This is
  the committed, always-taken path by which prototype agents are launched, and
  today it is the single loudest instruction to copy. It must instead say: copy
  `prototypes/_template/`, design from scratch, do not open any other prototype
  folder, do not read `plugins/`, keep the folder self-contained (`file://` must
  work). `improveText()` names only that one prototype's folder.

### 4. The no-siblings instruction (phase 1)

Preprompts turn out to be the wrong seam: they are `config_v2` list items
authored in Settings with `default: []`, i.e. user data, not repo files. The
committed instruction therefore lives in three places, in decreasing reliability:

1. **The launch prompts above** — always present in the first user turn.
2. **`prototypes/CLAUDE.md`** — the authoring contract (the shape above, the
   `file://` invariant, the flat-folder rule, metadata tags) plus the rule:
   design from a blank page, never read another prototype. It must not name or
   describe any existing prototype.
3. **A line in the root `CLAUDE.md`** pointing prototype work at
   `prototypes/CLAUDE.md` — the root file is always loaded, the nested one only
   once the agent touches that directory.

The user may additionally author a "Prototype design" preprompt in Settings
carrying the per-run brief (mood, constraints, and any fixture data — data
delivered in a prompt is a starting point that carries no design with it, unlike
a file in the tree).

### 5. A check — `plugins/apps/plugins/prototypes/plugins/files/check/index.ts`

Id `prototypes:self-contained`, following
`plugins/framework/plugins/tooling/plugins/checks/plugins/plugins-doc-in-sync/check/index.ts`
as the template for a check that reads repo-root files via `getWorktreeRoot()`.
It fails on:

- a prototype directory with no `index.html`, or an `index.html` with no `<title>`
- a subdirectory inside a prototype folder (unserveable by the router)
- a leftover `meta.json`
- any file referencing `_shared`, `../`, or **another prototype's directory
  name** — the machine-checkable half of self-containment

It cannot catch copied *design*; that is what phase 2 is for.

### 6. Tooling

- Remove `@source "…/prototypes/";` from
  `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css`. Prototypes
  never use the app's Tailwind, and the scan both couples them to the app's
  global stylesheet and invalidates its cache on every prototype edit. Update
  the comment in
  `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/global-css.ts`;
  its unit test uses its own fixture string, so verify but expect no change.
- Keep `"prototypes/**"` in the ESLint ignores in `build-lint-config.ts`.
- Update the hand-written prose in `plugins/apps/plugins/prototypes/CLAUDE.md`
  and the `files/` + `gallery/` `CLAUDE.md` files (above the autogen fence).

## What this does *not* guarantee

Phase 1 is instruction only. An agent that decides to look can still `ls
prototypes/`, and the sibling folders are right there. That is accepted for now.

**Phase 2, a follow-up:** launch prototype agents in a worktree sparse-checked-out
to `prototypes/_template` and their own folder, so siblings are not on disk at
all. Two residual holes need a `defineGuard` in
`plugins/framework/plugins/tooling/plugins/guards/`: git still has the objects
(`git show HEAD:prototypes/helix/index.html`), and the app serves every
prototype over HTTP at `/api/prototypes`. Neither is reachable by accident once
the names aren't visible, but both are reachable on purpose.

## Verification

1. Confirm the `<script type="text/babel" src>` ordering assumption in a scratch
   file **before** migrating both prototypes.
2. `./equin build`, then open `http://<worktree>.localhost:9000/prototypes`.
   The gallery lists `helix` and `mist-panes` with titles and blurbs read from
   their HTML.
3. Open one → Focus renders it correctly at its declared viewport; Compare shows
   both side by side.
4. **The self-containment test:** `open prototypes/helix/index.html` from Finder.
   It must render identically with no server running.
5. Edit a color in `prototypes/helix/styles.css` → the open iframe reloads and
   shows the new color (proves the watcher's extension list and `no-store`).
6. Scaffold check: copy `_template/` to `prototypes/scratch/`, confirm it appears
   in the gallery with the default 1280x800 canvas, then delete it.
7. `./equin check` passes, including the new `prototypes:self-contained`.
   Verify it fails as intended by temporarily adding a `meta.json` back.
8. Click "New prototype" and read the seeded prompt — confirm it points at
   `_template/` and forbids reading other prototypes.
