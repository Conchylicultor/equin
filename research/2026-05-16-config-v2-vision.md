# Config v2 — Vision

## Motivation

The current config system stores values in the database. Config v2 moves to human-readable JSONC files on disk, making config editable by both the UI and text editors/agents, with a clean abstraction layer that can be swapped to cloud storage later.

## Use cases

1. **Basic primitives** — boolean, string, number, enum. (e.g. "auto-build on push")
2. **Structured data** — Zod-typed objects. (e.g. shadow presets with color/opacity/blur/spread/offset fields)
3. **Collections** — Sorted lists of structured items, each with stable identity. (e.g. conversation categories, review file sections, prompt templates)
4. **UI ordering** — Each reorderable slot implicitly backs its rank state as config, so order is persisted, editable, and resettable.
5. **Theme tokens** — Color palettes, typography, shadows, shape — all expressible as config fields.

## API

### defineConfig

Each plugin declares its config with typed field helpers:

```ts
const config = defineConfig({
  fields: {
    autoBuild: boolField({
      default: true,
      label: "Auto-build on push",
      description: "Automatically run ./equin build when a push to main is detected.",
    }),

    reviewSections: listField({
      label: "Review sections",
      itemLabel: "Section",
      fields: {
        icon: avatarField(),
        name: textField({ label: "Name" }),
        paths: listField({
          label: "File patterns",
          fields: {
            pattern: textField({ placeholder: "src/**/*.ts" }),
          },
        }),
      },
    }),
  },
});
```

**Field types** — each field carries its Zod schema, default value, and UI renderer:

- `boolField` — toggle switch
- `textField` — single-line input
- `multiLineTextField` — textarea, optionally with attachments
- `numberField` — numeric input with optional min/max/step
- `enumField` — dropdown or radio group from a fixed set
- `avatarField` — icon + color picker
- `colorField` — color picker
- `listField` — sorted list of sub-items; nested `fields` define each item's shape
- `objectField` — grouped sub-fields rendered as a section
- `jsonField` — raw JSON editor for advanced/escape-hatch use

### useConfig

On the web side, `useConfig` returns reactive values that update live:

```ts
const { autoBuild, reviewSections } = useConfig(config);
```

On the server side, `config.get("autoBuild")` reads the current value synchronously from the in-memory cache.

## Storage

### Three-tier layout

Config flows through three tiers — code defaults, git-committed files, and user-local files — with hash-based conflict detection at each boundary:

```
Code (defineConfig defaults)
  ↓ ./equin build
Git committed: config/<hierarchy>/<name>.origin.jsonc    (auto-generated, do not edit)
               config/<hierarchy>/<name>.jsonc            (team overwrites, optional)
  ↓ server start (propagate)
User local:    ~/.singularity/config/<hierarchy>/<name>.origin.jsonc  (auto-copied)
               ~/.singularity/config/<hierarchy>/<name>.jsonc         (user overwrites, optional)
```

Each `defineConfig` maps to a single file. The path mirrors the plugin hierarchy: `config/conversations/conversation-category/categories.jsonc`.

Overwrites are **full copies** (not deltas). Each carries a `// @hash` of the origin it was derived from. Effective config = overwrites if present, else origin.

### ConfigProxy

Each tier boundary is mediated by a `ConfigProxy` — a read/write handle that pairs content with a hash:

```ts
interface ConfigProxy {
  read(): { content: JsonValue; hash: string | null } | null;
  write(content: JsonValue, hash: string | null): void;
  exists(): boolean;
}
```

Two implementations: `codeConfigProxy(descriptor)` (read-only, returns defaults) and `jsoncConfigProxy(filePath)` (JSONC on disk with `// @hash` header, atomic writes).

### ConfigStore

The config ↔ disk layer is a self-contained interface:

```ts
interface ConfigStore {
  read(path: string): Promise<JsonValue | undefined>
  write(path: string, value: JsonValue): Promise<void>
  watch(path: string, cb: (value: JsonValue) => void): Disposable
  list(): Promise<string[]>
}
```

The first implementation is JSONC-on-disk. The interface is the seam for future backends (cloud sync, multi-user).

### JSONC file format

```jsonc
// @hash a1b2c3d4e5f6
{
  // Auto-build on push
  "autoBuild": true
}
```

Origin files: hash = hash of own content (integrity). Overwrites: hash = hash of the origin they were copied from (conflict detection).

### Reactivity

A `@parcel/watcher` instance on `~/.singularity/config/` detects changes from any source (UI, text editor, agent). Changes emit through the existing live-state/notifications system so `useConfig` hooks re-render instantly.

## Default configs

### Repo defaults (origin files)

Auto-generated origin files are committed in a top-level `config/` folder in the repo:

```
config/
  conversations/
    conversation-category/
      categories.origin.jsonc
  build/
    config.origin.jsonc
```

These files are generated by `./equin build` from `defineConfig` declarations — they document every config field with description comments and provide the starting values. **Do not edit origin files directly** — they are regenerated on every build.

To customize defaults for the project, create a matching `.jsonc` file (without `.origin`) alongside, copy the content, edit values, and keep the `// @hash` line. This is a team overwrite committed to git.

### Build-time generation

During `./equin build`, configs are collected from all `defineConfig` declarations:

- Each plugin's `defineConfig` descriptor is discovered by importing server barrels.
- For each descriptor, a `config/<hierarchy>/<name>.origin.jsonc` is written with defaults and per-field description comments.
- Generation is idempotent — files are only written when content changes.
- The `config-origins-in-sync` check validates:
  1. Origin files on disk match what the code would generate (drift detection).
  2. Any committed overwrites (`.jsonc`) have a `// @hash` matching their origin's current hash (conflict detection).
- The check fails with actionable hints: "Run `./equin build`" for stale origins, or "Review origin, update overwrites, set `// @hash <expectedHash>`" for stale overwrites.

### Server-start propagation

When the server starts, git-committed config is propagated to `~/.singularity/config/` using `propagate()`:

1. Compute git-effective config: `effective(gitOrigin, gitOverwrites)`.
2. Propagate to user tier: `propagate(gitEffective, userOrigin, userOverwrites)`.
3. If user overwrites exist with a stale `@hash` → conflict is logged as a warning; user value is preserved.
4. If no user overwrites exist → origin is updated silently (user never customized).

User-local overwrites in `~/.singularity/config/` follow the same pattern: copy the origin, edit values, keep the `// @hash`. These are never committed.

## Collection identity

Every item in a `listField` automatically gets a stable `id: string` (UUID, assigned on creation). This ensures reordering, editing, and cross-referencing don't break when items move. The `id` is part of the persisted JSONC but hidden from the UI editor.

## Validation & graceful degradation

When reading config from disk:

- Valid JSONC, valid schema → use as-is.
- Valid JSONC, schema violation on some fields → use defaults for invalid fields, keep valid ones, surface warning toast.
- Invalid JSONC (parse error) → fall back to full defaults, surface error toast.

Never crash on bad config.

## Reset to defaults

The UI offers per-field and per-config-block reset. Resetting deletes the user's overwrites file — `effective()` falls through to the origin, which carries the repo defaults. Instant reset (no restart needed) by falling through to the in-memory default.

## Auto-registration in UI

`defineConfig` produces a contribution that the settings pane discovers automatically. Each field type carries its own React renderer. The settings pane walks all registered configs, grouped by plugin hierarchy, and calls `field.render()` for each. No manual registration step.

For documentation, the build step that generates `config/` files also updates `plugins-details.md` with each plugin's config fields — same pattern as slots and contributions.

## Import / export

Since config is a directory of JSONC files, backup/restore is `cp -r`. The backup plugin treats `~/.singularity/config/` as another backup source alongside DB and secrets.

## Migration from current system

A one-time migration reads all existing DB config rows, writes them as JSONC files to `~/.singularity/config/`, and drops the config table. This runs automatically on first server start after the cutover. Plugins update their `defineConfig` calls from the old DB-backed API to the new field-based API.
