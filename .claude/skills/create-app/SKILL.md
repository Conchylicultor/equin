---
name: create-app
description: >
  Rules for creating a new top-level app in the Singularity platform.
  Read BEFORE creating any new app.
---

# Create New App

## Rules

- New top-level apps go in: `plugins/apps/plugins/<name>/`
- The top-level app plugin must be **empty** — no slots, no components, no logic. It is a namespace only. The one thing it may hold is the app's data-dir declaration, `data-dirs/index.ts` (see below).
- All app content goes in sub-plugins: `plugins/apps/plugins/<name>/plugins/<feature>/`
- The app shell (layout, routing) is a sub-plugin, not the top-level plugin.
- Author the `Apps.App` `icon` via `mdAppIcon` from `@plugins/apps-core/plugins/app-icon/web` (the serializable `AppIcon` descriptor), e.g. `icon: mdAppIcon(MdSomeIcon)` with the glyph imported from `react-icons/md`.
- The shell sub-plugin owns the app's identity: `shell/core/app.ts` exports `export const <name>App = defineApp({ id, name, basePath, iconKey })` — `name` is the app's human-readable display name (rail tooltip, tab fallback title), authored ONLY here. Every pane of the app declares `Pane.define({ app: <name>App })` (mandatory), so this must exist before the first pane.
- The shell's web barrel hands that `AppRef` over whole: `Apps.App({ app: <name>App, icon: mdAppIcon(MdSomeIcon), component: <Name>Layout })`. There is no `id` / `path` / `tooltip` prop — the contribution restates nothing about the app.

## Files on disk: one data dir per app

An app's durable host-global files (content the user made, state that is the only copy) live in its **one** data dir, `~/.singularity/apps/<name>/` — never in a second `apps/*` dir, and never in `state/` from inside the app.

- Declare it at the app root, `plugins/apps/plugins/<name>/data-dirs/index.ts`, from the shell's `AppRef`:

  ```ts
  import { defineAppDataDir } from "@plugins/infra/plugins/paths/core";
  import { <name>App } from "@plugins/apps/plugins/<name>/plugins/shell/core";

  export const <name>Dir = defineAppDataDir(<name>App, {
    owner: "apps/<name>",
    description: "…",
  });
  export default [<name>Dir];
  ```

  The name comes from `app.id` and it is never reclaimable. `shell/core` must never import this file (that closes a cycle).
- A sub-plugin needing its own area imports `<name>Dir` from `@plugins/apps/plugins/<name>/data-dirs` and takes `<name>Dir.subdir("<area>")`. It does not declare a dir of its own, and it does not re-export `<name>Dir` from its barrel.
- Regenerable output (thumbnails, indexes you can rebuild) goes to a `cache/` dir instead (`defineDataDir({ kind: "cache", … })` in the sub-plugin's own `data-dirs/`).
- A second app dir is refused three ways: `defineDataDir({ kind: "apps" })` is a type error, a second `defineAppDataDir` for the same app throws, and the `paths:app-data-dirs` check fails a declaration that sits anywhere else. Rules and the reason behind them: `plugins/infra/plugins/paths/CLAUDE.md`.

## Example structure

```
plugins/apps/plugins/<name>/
  package.json
  web/index.ts              # Empty namespace plugin
  data-dirs/index.ts        # Optional: the app's one data dir (apps/<name>/)
  plugins/
    shell/
      package.json
      web/index.ts           # Contributes Apps.App, exports slots
      web/slots.ts
      web/components/
    <feature>/
      package.json
      web/index.ts           # Contributes to shell slots
```

Each `package.json` needs a `"name"` for `bun install`, but its value is derived from the
folder path and rewritten by `./equin build` — any unique placeholder works.
