# Prototypes

A prototype is a throwaway UI mockup: one flat folder in
`~/.singularity/apps/prototypes/<id>/`, with an `index.html`. It is **not in
the repo**: write there directly and commit nothing. That folder is shared by
every worktree and main and shows at `http://singularity.localhost:9000` as
soon as you save. No build is needed.

## Creating one

- `./singularity prototype new "Title"` mints the folder from `_template/` and
  prints its id. Never copy the template by hand, and never name the folder:
  other places refer to the prototype by its id, so the id must never change.
  Its name is the `<title>`.
- If your prompt already names a folder, edit that one instead.
- **One prototype per request.** Asked for several directions? Build all of them
  in one prototype, as an option (`direction: dense | airy | split`). The
  reader compares them by flipping one pill in place; separate prototypes
  become near-duplicate cards, each with its own history.
- Write the id (`proto-…`) in your messages: it renders as a chip that opens
  the prototype.

## History

Every agent turn that changes the folder is saved as a version, with the
request that caused it. Before changing a prototype that already has versions,
read how it got there:

```bash
./singularity prototype log <id> -p      # versions, requests, diffs
./singularity prototype restore <id> v3
./singularity prototype checkpoint <id> -m "…"   # only for edits outside an agent turn
```

The history is a bare git repo per prototype,
`~/.singularity/apps/prototypes/_history/<id>.git`; plain `git --git-dir …` may
**read** it (`log -S`, `show <sha>:index.html`). Never write to `_history/`, and
never create a `.git` inside a prototype folder.

## Rules

- **Design from a blank page.** Don't open other prototypes' folders or
  `plugins/` for inspiration. Prototypes exist to explore new ideas; starting
  from an existing answer defeats that.
- **Flat folder.** The server serves `<id>/<file>` only, so no subdirectories.
  Reference files relatively.
- **It must render opened off disk (`file://`).** So JSX goes inline in
  `index.html`: Babel can't fetch an external `src` there. CDN scripts, `.js`,
  `.css` and images are fine.
- **Fluid layout.** Use `max-width` and padding, and let grids stack. Never use
  a fixed `width: 1280px`. Compare shows the mock at several widths next to
  the real app, which reflows; a fixed-width mock gets cropped.
- **Filling one screen:** use `var(--prototype-screen-height, 100vh)` (in JS,
  read that property, falling back to `innerHeight`). With Whole page on, `100vh`
  is the whole page height.
- Make the smallest thing that shows the idea: a button, a card or a full app.
  React is optional.

## Metadata (in `<head>`)

```html
<title>Name</title>                          <!-- the only human name; required -->
<meta name="description" content="…" />      <!-- gallery card blurb -->
<meta name="prototype-viewport" content="phone" />
<meta name="mocks" content="exhibit:task-draft/composer" />
```

- `prototype-viewport`: **leave it out** (the page then fills the canvas)
  unless the design is for one kind of screen. A fluid page already shows at
  desktop size on a desktop, and the reader can pick a device. The value is a
  name: `phone`, `tablet`, `laptop`, `desktop`, `wide` or `window`. Not pixels.
- `mocks`: what real app thing this is a mockup of, so the canvas shows it
  alongside. `exhibit:<id>` is one component, `route:/path` one screen,
  `app:/path` the whole app with its chrome. Most prototypes leave it out.

## Options

Variants the reader flips between are **declared**, and the app draws the
picker outside the page. Never build a switcher, toggle bar or color input into
the page: the app's picker takes no canvas space and stays out of screenshots
and thumbnails.

```html
<html data-pane="flush" style="--accent: #7c5cff">
<meta name="prototype-option" content="pane: flush | floating | soft-tray" />
<meta name="prototype-option-group" content="Colors" />
<meta name="prototype-option" content="accent: color violet=#7c5cff | azure=#3b82f6" />
```

- **Choice:** name and values are lowercase tokens (`v` is a reserved name).
  The default is `data-<name>` on `<html>`. Style it with
  `:root[data-pane="floating"]`. A pick reloads the frame, so read it once.
- **Color:** use `color` plus suggested values, never a palette enum (an
  enum limits the reader to your guesses; a color option lets them pick any
  color). The
  default is `--<name>` in `<html style>`. Always read it through
  `var(--accent)` or `getComputedStyle` when you need it: a pick repaints live,
  without a reload, so a value copied at load goes stale.
- **Group:** a `prototype-option-group` line starts a group that runs to the
  next one. A prefix matching the group name is dropped on screen
  (`sidebar-width` under "Sidebar" reads "Width").
- An invalid line is left out of the picker and reported on the card.

`./singularity prototype options <id>` prints the variant the user is looking
at (one shared pick for every tab and deploy) and its URL. To render a variant,
load `/api/prototypes/<id>/index.html?pane=floating&accent=%2310b981`, e.g. with
`e2e-harness/e2e/screenshot.ts --path …`. **Never change the user's picks**:
clicking the picker in a browser script changes them for everyone.
