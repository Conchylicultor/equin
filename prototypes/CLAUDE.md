# Prototypes

A prototype is a throwaway UI mockup: one folder, one `index.html`, nothing
shared with anything else.

## Where they live: `~/.singularity/apps/prototypes/`, NOT this directory

**Prototypes are not checked in.** They live in `~/.singularity/apps/prototypes/<id>/`
and you commit nothing. This directory holds only `_template/` and this file.

Why: that one directory is shared by every worktree and by main. A mock you save
there is on screen immediately at `http://singularity.localhost:9000` — no build,
no push, no merge — and it outlives the worktree that wrote it. It is backed up
by the `prototypes` backup source, which is what makes it recoverable now that
git isn't.

`./singularity check` fails if a prototype folder appears in the repo.

## You do not create the folder by hand

```bash
./singularity prototype new "Your title"
```

That mints the folder, copies the blank `_template/` into it, and prints the id
and URL. **Never `cp -R _template …`, and never pick the folder name** — it is a
minted id (`proto-1786877040-w2vi`), not a slug, because the id is how a
prototype is referenced elsewhere and must not change when the mock gets its
real name. That name is its `<title>`; the gallery card, pane header and chips
all show that, never the id. `./singularity prototype list` prints both.

Launched from the gallery's **New prototype** button? The folder already exists
and your prompt names it — edit that one, don't mint a second.

Write the id in your messages: it renders as a chip that opens the mock in a
column beside the text.

## History: every turn is saved

Each agent turn that changes the folder is recorded as a **version**,
automatically — you do nothing. The user steps through versions with the
`‹ v3 of 7 ›` arrows in the prototype's pane, and can restore any of them.

Before you change a prototype someone has already iterated on, read how it got
here — what was asked for, what was tried, in what order:

```bash
./singularity prototype log <id>       # versions, newest first, with each request
./singularity prototype log <id> -p    # ... and the diff each one made
```

`./singularity prototype restore <id> v3` makes an old version live again
(nothing is lost: unsaved changes are saved first). `./singularity prototype
checkpoint <id> -m "…"` records a version by hand — only needed for edits made
outside an agent turn.

The history is kept beside the folder (`_history/`), not in it. **Never create a
`.git` or any subfolder inside a prototype folder**, and never touch
`_history/`.

## Design from a blank page

**Do not open another prototype's folder.** Not to see how it is built, not to
borrow a color, not to check a convention. Prototypes exist to explore ideas
that have not been had yet, and the fastest way to lose that is to start from
someone else's answer.

The folder you were given holds the blank `_template/` — deliberately
design-less, so everything you see on screen will be a decision you made. Do not
read `plugins/` either; the app's own components and tokens are not a starting
point here.

## The folder

```
~/.singularity/apps/prototypes/
  <id>/
    index.html     # the only required file
    styles.css     # optional
    data.js        # optional
    photo.png      # optional
```

**Flat, no subdirectories.** The server serves `<id>/<file>` and nothing
deeper, so `<id>/assets/icon.svg` will 404. Keep every file at the top level
of your folder.

Reference your files relatively: `href="styles.css"`, `src="data.js"`.

## It must open by double-click

**Open `~/.singularity/apps/prototypes/<id>/index.html` in Finder. It has to
render.** No server,
no build step. If it only works through the app, it is not a prototype.

That rules one thing out: **JSX cannot live in a separate file.** Babel fetches
a `<script type="text/babel" src="…">` over XHR, and the browser blocks that on
`file://`. Write your JSX inline in `index.html` instead. Plain `.js` files,
`.css` files, images and CDN `<script>` tags all load fine.

## The four metadata tags

The gallery reads these out of your HTML — there is no metadata file.

```html
<title>Your prototype</title>
<meta name="description" content="A sentence about what this explores." />
<meta name="prototype-viewport" content="phone" />
<meta name="mocks" content="exhibit:task-draft/composer" />
```

- `<title>` is the card's name — the prototype's ONLY human name, since the
  folder is an id. Without it every surface reads "Untitled prototype".
- `<meta name="description">` is the card's blurb.
- `<meta name="prototype-viewport">` pins the kind of screen the design is
  for. **Leave it out** unless the request is about one screen in particular:
  without it the page fills whatever room the canvas gives it (`responsive`),
  so its own responsive layout shows, and the reader picks a device from the
  size menu. Don't add one because the mock "looks like a desktop app" — a
  fluid page (see below) already shows at a desktop's size on a desktop. When
  you do pin one, it is a NAME, not pixels: `phone` (390×844), `tablet`
  (820×1180), `laptop` (1440×900), `desktop` (1920×1080), `wide` (2560×1440),
  or `window` (the size the viewer's own browser window gives the real app).
  The canvas opens at it, and the gallery card renders at it (`window` and
  `responsive` render at laptop). A pixel size (`1320x868`) is not read — it
  is reported as a problem on the card. Don't turn it into a fixed width in
  your CSS (see below).
- `<meta name="mocks">` names the real app thing this prototype is a mockup
  of, as `<kind>:<ref>`, so the canvas can put the two side by side (its Real app frame):
  - `exhibit:task-draft/composer` — one real app **component**, by its exhibit
    id: any plugin's `exhibits/` folder (the `plugin-meta/exhibits` catalog,
    browsable in Debug). An `isolated` exhibit renders anywhere from plain
    props; an `app` one as the running app renders it (real slots, config,
    data) — the way to reach an element that lives inside a popover or deep in
    a screen, which `route:` cannot.
  - `route:/agents/c/123` — a whole app **screen**: the running app itself,
    framed at that in-app path (no rail, no tab bar).
  - `app:/agents` — the **whole app**, chrome included: the running app at that
    path with its rail, tab bar and action bar, as a person sees it in their own
    tab. For a mock of the chrome itself, or of a theme across chrome and screen.

  The kinds are open — the Real app frame lists the ones this worktree knows,
  with an example of each. A value with no `<kind>:` prefix is reported as a
  problem on the card. Most prototypes are not a mockup of anything in the app —
  leave the tag out and nothing is missing.

A fifth, `<meta name="prototype-option">`, declares variants — see Options.

## Lay it out fluid, not at a fixed width

Use `max-width` plus side padding, not `width: 1280px`, and let grids stack when
there is no room. The template's `#root` already fills its frame.

Why: with a `mocks` tag, Compare frames your mock at the widths the reader picks
(a `route:` or `app:` counterpart offers 390 / 820 / 1440 / 1920 / 2560, or the reader's own window), and your media
queries run. A fixed-width mock gets cropped there while the real screen
reflows beside it. So a mock of a screen needs breakpoints for those widths.

## Sizing something to the screen

With **Whole page** on, the canvas makes the frame as tall as your page, so
`100vh` and `window.innerHeight` are the whole page, not one screen. A page
that sizes itself from them in script grows with its frame, without end — the
canvas detects that and disables Whole page for it ("sized to its window").

To fill one screen, read the screen height the app gives every frame instead,
falling back to the window off disk:

```css
.hero { height: var(--prototype-screen-height, 100vh); }
```

```js
const screenHeight = () =>
  parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue("--prototype-screen-height")) || window.innerHeight;
window.addEventListener("resize", layout); // fired when it changes, too
```

## One request, one prototype

**Only ever create a single prototype.** Run `./singularity prototype new` at
most once per request — and not at all when your prompt already names a folder.
Asked for three directions, three layouts or "a few ideas"? That is still one
prototype: build every direction inside it and declare them as an option (see
below), e.g. `direction: dense | airy | split`.

Why: the reader compares variants by flipping one pill in place — same canvas,
same scroll, same history. Spread across separate prototypes, the variants turn
into near-duplicate gallery cards with forked version histories, and comparing
them means jumping between panes.

## Options: variants the reader flips between

If the design has versions to compare — a pane style, a density, an accent
color, or whole alternative designs — **declare them; never build a switcher,
toggle bar, color input or settings panel into the page to flip between them,
and never split them into separate prototypes.** The app draws the picker
itself, as a small pill floating over the stage, outside your page. So your page
holds only the design: the picker takes no canvas space, shows up in no
screenshot or thumbnail, and your CSS never has to style it.

There are two kinds: a **choice** (one of a fixed list of values) and a
**color** (any color, with your suggestions).

```html
<html lang="en" data-pane="flush" data-density="cozy" style="--accent: #7c5cff">
<head>
<meta name="prototype-option" content="pane: flush | floating | soft-tray" />
<meta name="prototype-option" content="density: cozy | compact" />
<meta name="prototype-option" content="accent: color violet=#7c5cff | azure=#3b82f6 | mint=#10b981" />
```

- **One tag per option**: `<name>: <value> | <value> | …`. Tag order is picker
  order; value order is chip order. Names are lowercase letters, digits and
  dashes starting with a letter (`v` is reserved); values are lowercase letters,
  digits and dashes (`3-octaves` is fine). The picker shows them humanized
  (`soft-tray` → "Soft tray"), so pick readable tokens.
- **A choice's default is the attribute you write on `<html>`**:
  `data-<name>="<value>"`, one of the declared values. The page then carries the
  attribute everywhere — double-clicked off disk, in the thumbnail, in the app —
  and the app only overwrites it with the value the reader picked.
- **Style each value** with `:root[data-pane="floating"] { … }` (the default can
  be targeted the same way), or read `document.documentElement.dataset.pane`
  in JS. Read it once, at load: picking a value reloads the frame with the new
  attribute, so nothing has to listen for a change.

### Many options? Group them

Past a handful of options the picker becomes a wall of rows. Group them:
a `<meta name="prototype-option-group" content="<label>">` line starts a group,
and every option declared after it — up to the next group line — belongs to it.
Options declared before the first group line stay ungrouped, on top.

```html
<meta name="prototype-option" content="pane: flush | floating" />
<meta name="prototype-option-group" content="Sidebar" />
<meta name="prototype-option" content="sidebar-nav: flat | grouped" />
<meta name="prototype-option" content="sidebar-width: 246 | 264 | 280" />
<meta name="prototype-option-group" content="Colors" />
<meta name="prototype-option" content="accent: color violet=#7c5cff | azure=#3b82f6" />
```

The picker draws each group as a titled section the reader can fold (folded,
it lists the group's picks). A grouped option whose name starts with the
group's label drops it on screen — `sidebar-width` under "Sidebar" reads
"Width" — so keep the prefix in the name (it is still the `data-*`
attribute and the query key, and must stay unique) and let the group carry it.
Group by what the reader compares together (one region of the screen, one
component, the colors), not by kind.

### Colors are a `color` option, never a palette enum

A color the reader might want to tune — an accent, a surface, a brand color —
is a **`color` option**, never `palette: violet | indigo | azure`. With an enum
the reader can only flip between your guesses; with a color option they can
pick the exact color they want, and the mock repaints live as they drag.
Several colors are several color options.

- **`<name>: color <suggestion>=<color> | …`** — the `color` keyword, then your
  suggestions (zero or more), each a name (a value token, as above) and a CSS
  color: `#rrggbb`, `oklch(…)`, `rgb(…)` or `hsl(…)`, opaque. The picker shows
  them as swatches beside a custom color picker.
- **The default is the `--<name>` custom property in `<html style>`**:
  `<html style="--accent: #7c5cff">`. Like a choice's attribute, it renders off
  disk and in the thumbnail, and it is exactly the property the app overrides.
- **Read it with `var(--accent)`**, in CSS (`color-mix()` derives shades
  from it), or `getComputedStyle(document.documentElement)` in JS at the moment
  you need it. **Never copy it into a JS variable at load:** a color pick does
  NOT reload the frame — the app sets `--accent` on the live page as the reader
  drags — so a value read once goes stale.
- A pick is stored as a suggestion's name or a lowercase `#rrggbb`.

Not an option: a control that is part of the design itself (the product's own
dropdown, a play button in a player). Options are for the reader choosing which
version of the design to look at.

A line that cannot be an option (malformed, a missing or unknown default, a
color that cannot be read, a duplicate) is left out of the picker and reported
as a problem on the card.

### Which variant is the user looking at?

The user's picks are one shared record per prototype: every tab and every
deploy (main and each worktree) shows the same variant and follows a new pick
live. Read it from the terminal:

```bash
./singularity prototype options <id>
```

It prints each option with the value on screen (picked, or the page's default)
and its values — a color option as its `#rrggbb` (and its suggestion's name),
the color to bake in when the user has settled on one — then the document URL
of exactly that variant. The user may
flip a variant at any time, so run this when it matters. `prototype list` shows a
`picked:` line under each prototype that is not on its defaults.

### Rendering a variant yourself

Load the prototype's document with the options in its query — the same
`?<option>=<value>` the app puts on its frames:

```bash
./singularity run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
  --path "/api/prototypes/<id>/index.html?pane=floating&accent=%2310b981"
```

The server stamps the values onto `<html>` (`data-*` for a choice, `--<name>` in
its `style` for a color: a suggestion's name, or a hex with its `#` written
`%23`), so the page renders that variant; a name or value the page does not declare is a 400, not the default.
`prototype options` prints the line for the current variant, ready to run.

**Never change the user's picks.** They are the user's choice of what to look
at; there is no command that sets them, and loading a document URL saves
nothing. (A browser script that clicks the picker does change them, for
everybody — the e2e harness puts them back when its run ends.)

## A prototype can be anything

Not necessarily a full-screen app. A single button, one card, a menu opening, a
color study, three headers side by side — all prototypes. Build the smallest
thing that shows the idea.

React is optional. Plain HTML and CSS is often enough; uncomment the template's
CDN tags only when you need state.
