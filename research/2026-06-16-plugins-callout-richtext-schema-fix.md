# Callout block `text` schema — tolerate legacy string + RichText

## Context

Loading certain Pages app pages throws an uncaught `ZodError` to the browser
console on plain page load (no dialog/feature involved):

```
invalid_type, expected string, received array, path: ["text"]
```

**Root cause (verified against the DB).** Every text-bearing block stores its
`text` as `string | RichText` (`RichText` = `TextRun[]`, an array of runs — see
`plugins/page/plugins/editor/core/rich-text.ts`). New writes through
`BlockTextEditor` persist the **array** form. The canonical text contract
`textDataSchema` (and the `to-do` / `toggle` block schemas) correctly type the
field as `RichTextSchema = z.union([z.string(), z.array(TextRunSchema)])`.

The **callout** block schema is the lone exception — it declares
`text: z.string().default("")`. When a callout is edited, its `text` becomes a
run array, and on the next page load `calloutBlock.parse(block.data)` throws.

Confirmed on the repro page (`block-1781565032936-opkgy5` "reer" in worktree
`att-1781615935-lesu`): callout block `83667dcc-…` stores
`"text": [{"text": "fdgdfVersion history test paragraph one."}]` — an array.

This is pre-existing, unrelated to version history (surfaced during version-history
verification).

**Backfill claim — does not reproduce.** The task also reported the
content-search backfill failing for affected pages. Verified it does **not**:
`reindexPageSearch` reads block text via `textOf` → `plainOf`, which already
tolerates both forms, and the repro page is present in `search_documents`
(`body_len = 55`). No change needed there; noting for the record.

**Sibling instances of the same wrong assumption.** Two server paths in
`inline-date` also assume `text: z.string()` via `safeParse`. They don't crash
(safeParse fails closed) but **silently drop** reminder tokens / snippet text for
any block already migrated to run arrays — a latent bug of the same class. Per
the repo principle "fix the class, not the instance," they are fixed in the same
pass using the existing `plainOf` coercer (the exact pattern already used by
`inline-page-link/server/internal/extract-inline-links.ts`).

## Changes

### 0. Structural fix — single source of truth for the `text` field

Currently **every** text-bearing block re-declares the `text` field by hand
(`textDataSchema`, `to-do`, `toggle`, and the now-broken `callout`). There is no
shared definition, so a future block author can re-introduce `text: z.string()`
exactly as callout did. The structural fix is a tiny factory so the field has one
definition that text-bearing blocks compose.

`plugins/page/plugins/editor/core/text-data.ts` — add and export:

```ts
/**
 * Schema factory for text-bearing block types (anything rendered through
 * `BlockTextEditor`). Guarantees the `text` field is the canonical
 * `string | RichText` contract, plus caller-supplied extra fields. Composing
 * this — rather than re-declaring `text` — makes a string-only `text` field
 * structurally impossible for new blocks.
 */
export function textBlockSchema<T extends z.ZodRawShape>(extra: T) {
  return z.object({ text: RichTextSchema, ...extra });
}

export const textDataSchema = textBlockSchema({});
```

Export `textBlockSchema` from the editor core barrel
(`plugins/page/plugins/editor/core/index.ts`).

Then route the existing text-bearing block schemas through it (single source of
truth; no behavior change — they already used `RichTextSchema`):

- `plugins/page/plugins/to-do/core/to-do-block.ts`:
  `textBlockSchema({ checked: z.boolean().default(false) })`
- `plugins/page/plugins/toggle/core/toggle-block.ts`: `textBlockSchema({})`

> A lint rule banning `text: z.string()` in block schemas was considered and
> rejected — `TextRunSchema.text` is legitimately a string, and statically
> identifying "block data schemas" is fragile (false positives). The factory is
> the proportionate fix: it makes the correct path the default and gives one
> place to change the contract.

### 1. Callout schema — the crash (primary fix)

`plugins/page/plugins/callout/core/callout-block.ts`

Compose the factory instead of re-declaring `text` as a string:

```ts
import { defineBlock, SvgNodeSchema, textBlockSchema } from "@plugins/page/plugins/editor/core";

export const calloutDataSchema = textBlockSchema({
  icon: z.string().nullable().default(null),
  iconSvgNodes: z.array(SvgNodeSchema).nullable().default(null),
  color: z.enum(CALLOUT_COLORS).default("default"),
});
```

- The previous `text: z.string().default("")` default is dropped — matching
  `textDataSchema` / `to-do` / `toggle`, which carry no default; `empty()` still
  seeds `text: ""` and `RichTextSchema` accepts a plain string.
- No DB migration: the `string | RichText` union *is* the back-compat seam.
- The renderer (`callout/web/components/callout-block.tsx`) only reads `color` /
  `icon` / `iconSvgNodes` off the parsed data; `text` is rendered by
  `BlockTextEditor`, which already coerces via `runsOf`, and
  `editor.update({ ...data, ... })` round-trips the (now array-valued) `text`
  unchanged. No renderer change needed.

### 2. inline-date reconcile — silent reminder loss (same class)

`plugins/page/plugins/inline-date/server/internal/reconcile.ts`

```ts
import { plainOf } from "@plugins/page/plugins/editor/core";

const TextShape = z.object({ text: z.unknown() });

function blockText(data: unknown): string {
  const r = TextShape.safeParse(data);
  return r.success ? plainOf(r.data.text) : "";
}
```

### 3. inline-date fire-job — silent snippet loss (same class)

`plugins/page/plugins/inline-date/server/internal/fire-job.ts`

```ts
import { plainOf } from "@plugins/page/plugins/editor/core";

const TextShape = z.object({ text: z.unknown() });
// …
const blockParsed = block ? TextShape.safeParse(block.data) : undefined;
const snippet = blockParsed?.success ? stripInlineTokens(plainOf(blockParsed.data.text)) : "";
```

`stripInlineTokens` still receives a plain string (now flattened from runs via
`plainOf`); `PageShape` (the `title` parse) is unaffected and stays as-is.

## Critical files

- `plugins/page/plugins/editor/core/text-data.ts` — add `textBlockSchema` factory
- `plugins/page/plugins/editor/core/index.ts` — export `textBlockSchema`
- `plugins/page/plugins/callout/core/callout-block.ts` — primary fix (the crash)
- `plugins/page/plugins/to-do/core/to-do-block.ts` — route through factory
- `plugins/page/plugins/toggle/core/toggle-block.ts` — route through factory
- `plugins/page/plugins/inline-date/server/internal/reconcile.ts` — sibling fix
- `plugins/page/plugins/inline-date/server/internal/fire-job.ts` — sibling fix
- Reference precedents (no change): `plugins/page/plugins/editor/core/rich-text.ts`
  (`RichTextSchema`, `runsOf`, `plainOf`),
  `plugins/page/plugins/inline-page-link/server/internal/extract-inline-links.ts`
  (the `z.unknown()` + `plainOf` pattern).

## Verification

1. `./equin build` from the worktree.
2. Reproduce-before / confirm-after with a scripted Playwright load of the repro
   page and a check for the console ZodError:
   ```bash
   bun e2e/screenshot.mjs --url http://att-1781623819-3p8w.localhost:9000/pages/page/block-1781565032936-opkgy5 --out /tmp/callout
   ```
   (the page must exist in this worktree's DB — if not, create a callout, type
   into it, reload, and confirm no `ZodError: …path: ["text"]` in the browser
   console / `~/.singularity/worktrees/<wt>/logs/*.jsonl`). Callout text must
   render correctly and stay editable.
3. inline-date: in a callout/text block that has a `[[reminder:<id>:<iso>]]`
   token authored via the editor (so `text` is a run array), confirm the
   reminder row is created (`query_db` on `page_reminders`) and the fired
   notification description shows the block snippet — previously empty for
   array-form blocks.
4. `./equin check` (type-check + boundaries) passes.
