# owner-config/

The OWNER's committed config: values that are this instance's owner's own —
their prompt templates, preprompts, conversation categories, review paths —
committed so every worktree of the checkout reads them, but never shipped.

`config/` is the shipping layer: the code defaults (`.origin.jsonc`) and the
overrides every install gets (authored layouts, views, app themes). This
directory sits on top of it, in the same layout:

```
owner-config/<plugin-tree>/<name>.jsonc            # replaces config/<plugin-tree>/<name>.jsonc
owner-config/<plugin-tree>/@app/<id>/<name>.jsonc  # an app-scoped delta, as in config/
```

- **Overrides only.** The origin is always `config/<plugin-tree>/<name>.origin.jsonc`,
  and each file's `// @hash` is anchored to it, exactly like a shipping override.
  An owner override replaces the shipping one (overrides are whole documents).
- **Who reads it:** the desktop runtime (`config_v2/machine`'s `repoConfigLayer`)
  and the build's propagation into the owner's own namespaces
  (`propagateConfigToUser({ ownerLayer: true })`). **Who never does:** a browser
  host (the demo bundles `config/` alone, `config_v2/plugins/bundled-layer`) and a
  release (`ownerLayer: false`) — what ships to someone else is a fresh install's
  config.
- **Hand-written, never generated or pruned.** `config-origins-in-sync` fails on a
  stale `@hash`, a schema-invalid document, a file whose config no longer exists
  (move or delete it yourself), and any `.origin.jsonc` / `.ancestor.jsonc` here.
  `./equin plugin move` moves this directory's share with the plugin.

Where a value belongs: if every user of the app should get it, it is a shipping
override in `config/`; if it is how the owner likes their own instance, it is
here (or in the user layer, `~/.equin/state/config/`, via the UI).
Design: `research/2026-11-04-global-demo-config-without-owner-layer.md`.
