# Fields migration — batch 4 (final): string-list

## Context

The unified `fields/` primitive reorganizes field-type knowledge into a
`type × capability` matrix under `plugins/fields/plugins/<type>/`. Batches 1–3
relocated every config field type (text, bool, int, float, multiline-text, enum,
dynamic-enum, color, avatar, list, object, secret) out of
`plugins/config_v2/plugins/fields/plugins/` and into the matrix.

**`string-list` is the last straggler.** It is still the *only* sub-plugin under
`plugins/config_v2/plugins/fields/plugins/`, which leaves the `config_v2` fields
umbrella with an inconsistent home for one field type. This batch relocates it,
following the exact precedent of the completed migrations (closest analog:
`list` — also a config-only, no-`coerce` type). After this, the `config_v2`
fields umbrella owns no field-type sub-plugins: it is purely the owner of the
frozen renderer-dispatch slot `config-v2.fields.renderer` and its shared
renderer helpers.

This is a **pure relocation + import-path update**, behavior-preserving, with one
small consistency addition: a `stringListIdentity` registered in the
`fields.identity` slot (the current `string-list` registers none, but every
migrated type — including `list` — does, and the matrix convention requires it).

## Invariants (load-bearing strings — must not change)

| Invariant | Value |
|---|---|
| Renderer dispatch slot id | `"config-v2.fields.renderer"` (owned by `config_v2/plugins/fields/web`, unchanged) |
| Dispatch key | `field.type.id` |
| `stringListFieldType.id` | `"string-list"` |
| Identity slot id | `"fields.identity"` (owned by `plugins/fields/web`, unchanged) |

The renderer keeps contributing to the same slot with the same id, so dispatch
is unaffected by the move. `reorder` consumes the *factory + Def* only.

## Target structure (mirrors `list`)

```
plugins/fields/plugins/string-list/
  package.json                         @singularity/plugin-fields-string-list
  CLAUDE.md
  core/
    index.ts                           re-export stringListFieldType, stringListIdentity
    internal/string-list-type.ts       token + identity (NO coerce, NO extends)
  web/
    index.ts                           Fields.Identity({ identity: stringListIdentity })  (from @plugins/fields/web)
  plugins/config/
    package.json                       @singularity/plugin-fields-string-list-config
    CLAUDE.md
    core/
      index.ts                         re-export stringListField, StringListFieldDef
      internal/string-list.ts          factory + Def
    web/
      index.ts                         Fields.Renderer(StringListRenderer)  (from @plugins/config_v2/plugins/fields/web)
      components/string-list-renderer.tsx   moved renderer (byte-for-byte)
```

### Token + identity — `core/internal/string-list-type.ts`

```ts
import { MdFormatListBulleted } from "react-icons/md";
import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";

export const stringListFieldType = defineFieldType<string[]>("string-list");

export const stringListIdentity = defineFieldIdentity<string[]>({
  type: stringListFieldType,
  label: "String List",
  icon: MdFormatListBulleted,
});
```

- No `coerce` (a `string[]` has no natural scalar — same as `list`).
- No `extends`.
- `core/index.ts` re-exports `stringListFieldType`, `stringListIdentity`.

### Type-level web barrel — `web/index.ts`

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Fields } from "@plugins/fields/web";
import { stringListIdentity } from "../core";

export default {
  name: "Fields: String List",
  description:
    "String-list field type: identity only. The config-render capability and the stringListField factory live in the plugins/config sub-plugin.",
  contributions: [Fields.Identity({ identity: stringListIdentity })],
} satisfies PluginDefinition;
```

### Factory + Def — `plugins/config/core/internal/string-list.ts`

Moved from the current `core/internal/string-list.ts`, with the token import
re-pointed at the type core (the `defineFieldType` call leaves this file; only
the factory, Def, and zod schema remain):

```ts
import { z } from "zod";
import {
  pickMeta,
  type FieldDef,
  type FieldMeta,
} from "@plugins/config_v2/core";
import { stringListFieldType } from "@plugins/fields/plugins/string-list/core";

export interface StringListFieldDef extends FieldDef<string[]> {
  readonly type: typeof stringListFieldType;
}

export function stringListField(
  opts?: FieldMeta & { default?: string[] },
): StringListFieldDef {
  return Object.freeze({
    type: stringListFieldType,
    schema: z.array(z.string()),
    defaultValue: opts?.default ?? [],
    meta: pickMeta(opts),
  });
}
```

> Note: the original inlines `meta: { label, description, placeholder }`. The
> migrated `avatar`/`list` config cores use the shared `pickMeta` from
> `@plugins/config_v2/core` for the identical object — adopt `pickMeta` to match
> precedent (behavior-identical).

`plugins/config/core/index.ts` re-exports `stringListField`, `StringListFieldDef`.

### Renderer — `plugins/config/web/components/string-list-renderer.tsx`

Moved **byte-for-byte** (incl. its local `useLocalValue`), only the token import
path changes to `@plugins/fields/plugins/string-list/core`. `FieldRendererComponent`
still comes from `@plugins/config_v2/plugins/fields/web`. `StringListRenderer.type =
stringListFieldType` unchanged.

`plugins/config/web/index.ts` contributes `Fields.Renderer(StringListRenderer)`
(`Fields` from `@plugins/config_v2/plugins/fields/web`).

### package.json files (mirror `list`)

- `plugins/fields/plugins/string-list/package.json` →
  `@singularity/plugin-fields-string-list`, `"version": "0.0.1"`, `"private": true`,
  `"singularity": { "collapsed": true }`.
- `plugins/fields/plugins/string-list/plugins/config/package.json` →
  `@singularity/plugin-fields-string-list-config`, same shape.

## Importer to update (the only one)

`plugins/reorder/shared/directive.ts` (lines 3–6) — change:

```ts
import {
  stringListField,
  type StringListFieldDef,
} from "@plugins/config_v2/plugins/fields/plugins/string-list/core";
```

to:

```ts
import {
  stringListField,
  type StringListFieldDef,
} from "@plugins/fields/plugins/string-list/plugins/config/core";
```

No other source file imports any string-list symbol (verified — remaining hits
are `bun.lock`, autogenerated docs, and research `.md` files, all rebuilt/ignored).

## Delete the old tree

Remove `plugins/config_v2/plugins/fields/plugins/string-list/` entirely. The now-empty
`plugins/config_v2/plugins/fields/plugins/` directory should also be removed (the
umbrella keeps `web/`, `package.json`, `CLAUDE.md` — only the `plugins/` subtree goes).

## Doc-prose cleanup

The `config_v2` fields umbrella is no longer a field-type registry; it is the
renderer-slot owner. Update prose (autogen blocks regenerate on build — do **not**
hand-edit those):

1. **`plugins/config_v2/plugins/fields/CLAUDE.md`** — replace the stale hand-authored
   "Adding a new field type" section (which still documents the old in-tree
   `plugins/config_v2/plugins/fields/plugins/<name>/` two-runtime pattern) with a short
   description of its actual role: owner of the `config-v2.fields.renderer` dispatch
   slot plus shared renderer helpers (`FieldHeader`, `useLocalValue`, `FieldRenderer`,
   `ConfigFieldContext`, `FieldRendererComponent`). Point readers to
   [`plugins/fields/CLAUDE.md`](../../../fields/CLAUDE.md) for adding field types.
2. **`plugins/config_v2/plugins/fields/package.json`** `description` — update from
   "Field type registry. Sub-plugins contribute…" to reflect the slot-owner role.
3. **New `CLAUDE.md`** for each new plugin (type-level + `plugins/config`), hand-written
   prose mirroring `list`'s two CLAUDE.md files; autogen reference blocks fill on build.

## Execution order

1. Create `plugins/fields/plugins/string-list/` (type core + web with identity).
2. Create `plugins/fields/plugins/string-list/plugins/config/` (core factory + web renderer),
   porting `string-list.ts` (token import re-pointed, `pickMeta` adopted) and
   `string-list-renderer.tsx` (byte-for-byte, token import re-pointed).
3. Add the two `package.json` files and the two `CLAUDE.md` files.
4. Update `plugins/reorder/shared/directive.ts` import path.
5. Delete `plugins/config_v2/plugins/fields/plugins/string-list/` (and the now-empty
   `plugins/` subdir).
6. Do the doc-prose cleanup above.
7. `bun install` (new workspace package names), then `./equin build`
   (regenerates registries + autogen doc blocks), then `./equin check`.

## Critical files

- Move/split: `plugins/config_v2/plugins/fields/plugins/string-list/core/internal/string-list.ts`
  → type token+identity in `fields/plugins/string-list/core/internal/string-list-type.ts`
  + factory/Def in `fields/plugins/string-list/plugins/config/core/internal/string-list.ts`.
- Move: `…/string-list/web/components/string-list-renderer.tsx`
  → `fields/plugins/string-list/plugins/config/web/components/string-list-renderer.tsx`.
- Edit: `plugins/reorder/shared/directive.ts`.
- Edit prose: `plugins/config_v2/plugins/fields/CLAUDE.md`, `…/fields/package.json`.

## Verification

- `bun install` succeeds; `./equin build` succeeds; `./equin check`
  passes (`plugin-boundaries`, `migrations-in-sync`, `eslint`, `plugins-doc-in-sync`,
  `config-origins-in-sync`).
- `rg` confirms **zero** remaining `@plugins/config_v2/plugins/fields/plugins/string-list`
  imports anywhere outside research `.md`, and the old tree is gone.
- `rg --files plugins/config_v2/plugins/fields/plugins` returns nothing (umbrella owns
  no field-type sub-plugins).
- App (`http://<wt>.localhost:9000`): a reorder directive still works end-to-end —
  enter reorder edit mode, drag a slot's contributions to reorder/hide, confirm the
  `order`/`hidden` `stringListField`s persist (these are the live consumers of
  `reorderDirectiveDescriptor`). Open Settings → the reorder directive config (or any
  config using a string-list) and confirm the textarea renderer (one item per line)
  renders, edits, and persists to JSONC.
- Studio → fields matrix shows `string-list` alongside the other types with its
  "String List" identity (label + icon); the old `config_v2 › fields › string-list`
  entry is gone.
```
