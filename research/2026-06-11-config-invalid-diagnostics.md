# Config invalid-conflict diagnostics: pinpoint the bad field + expose all layers

## Context

When a stored config fails the current schema, the settings detail pane
(`/agents/config/cd/<storePath>`) shows a destructive banner:

```
Stored config is invalid for the current schema
items.6: Invalid input
```

This is not actionable for two reasons:

1. **It doesn't show *what* is wrong.** `items.6: Invalid input` is a bare
   zod `path: message` string. It omits the offending value — even though that
   value is sitting right there in the conflict payload. Grounded example:
   `config/apps/apps.app.jsonc` (the git-layer override) carries
   `items[6] = { "spacer": "spacer-1" }`, the **old** spacer format; the current
   schema expects `{ "type": "spacer", "id": "…" }`. The banner never reveals
   that `{ "spacer": "spacer-1" }` is the culprit.

2. **The raw-file view hides the git layer.** `getConfigRawFile` only reads the
   user layer (`~/.singularity/config/<worktree>/…`). The actual invalid data
   lives in the repo's git-layer override (`<repo>/config/apps/apps.app.jsonc`),
   which gets propagated into the user-layer `*.origin.jsonc` and surfaces only
   under the label "Origin" — with no indication it came from a committed git
   file. Hence "raw-file only shows origin, not git."

**Outcome:** the invalid banner names the exact offending value per issue and
offers a side-by-side diff; the raw-file view lists every config layer
(User → Git → Origin) so the user can see precisely which file holds the bad data.

### Why this is the correct scope

The underlying *data* bug (a stale git override after the spacer schema changed)
is a separate concern — the user is asking the **UI to expose** the failure, not
to auto-fix the file. This change is purely diagnostics: richer error surfacing,
no change to resolution/propagation semantics.

## Current data flow (traced)

- **Validation** — `validationIssues()`
  (`plugins/config_v2/core/internal/tier-logic.ts:88-100`) runs `safeParse` and
  maps each `ZodIssue` to a flat string `` `${i.path.join(".")}: ${i.message}` ``.
  The structured `path` array and the offending value are discarded.
- **Conflict payload** — `computeAllConflicts()`
  (`plugins/config_v2/server/internal/resource.ts:110-155`) emits
  `{ kind: "invalid", originValues: defaults, overrideValues: <stored doc>, issues }`.
  `overrideValues` = `effective(origin, overwrites)` = the stored invalid document,
  so **the offending value is already in the payload** — the client just needs the
  structured path to drill into it.
- **Schema** — `configV2ConflictEntrySchema.issues: z.array(z.string()).optional()`
  (`plugins/config_v2/core/internal/resource.ts:13-29`).
- **Render** — `ConfigDetailInner`
  (`plugins/config_v2/plugins/settings/web/components/config-detail.tsx:151-182`)
  renders each issue string as a bare `<li>`.
- **Raw view** — `RawFileView` (same file, `:250-280`) calls `getConfigRawFile`,
  which returns only user-layer `{ origin, override }`
  (`plugins/config_v2/server/internal/registry.ts:494-514`,
  endpoint `plugins/config_v2/plugins/settings/core/internal/endpoints.ts:19-23`).
- **Git-layer files** live at
  `<REPO_ROOT>/config/<hierarchyPath>/<name>{.origin}.jsonc` (`REPO_ROOT` from
  `@plugins/infra/plugins/paths/server`). The user layer mirrors them under
  `CONFIG_DIR = <SINGULARITY_DIR>/config/<worktree>`
  (`plugins/config_v2/server/internal/config-dir.ts`).
- **Reusable diff** — `TextDiff`
  (`@plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/plugins/diff/web`),
  already wrapped by `ConflictDiff`
  (`plugins/config_v2/plugins/settings/web/components/conflict-diff.tsx`) for
  hash conflicts.

## Design

### 1. Structured validation issues (core)

Replace the flat-string issue with a structured record so the client can drill
the offending value and the diff button has a precise target.

**`plugins/config_v2/core/internal/resource.ts`**
- Add and export:
  ```ts
  export const configV2ValidationIssueSchema = z.object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  });
  export type ConfigV2ValidationIssue = z.infer<typeof configV2ValidationIssueSchema>;
  ```
- Change the conflict entry field:
  ```ts
  issues: z.array(configV2ValidationIssueSchema).optional(),
  ```
- Export `configV2ValidationIssueSchema` / `ConfigV2ValidationIssue` from the
  core barrel (`plugins/config_v2/core/index.ts`).

**`plugins/config_v2/core/internal/tier-logic.ts`**
- `validationIssues()` returns `ConfigV2ValidationIssue[] | null`:
  ```ts
  return result.error.issues.map((i) => ({ path: i.path, message: i.message }));
  ```
- `readTypedConfig()`'s `console.warn` keeps the human string by joining inline
  (`i.path.join(".") || "(root)"`), so log output is unchanged.

No change needed in `computeAllConflicts()` beyond the now-structured type.

### 2. Expose git layer in the raw-file endpoint (server)

**`plugins/config_v2/plugins/settings/core/internal/endpoints.ts`** — extend the
response (additive, backward-compatible shape):
```ts
response: z.object({
  override: z.string().nullable(),     // user layer (~/.singularity/.../<name>.jsonc)
  origin: z.string().nullable(),       // user-layer origin (propagated; app reads this)
  gitOverride: z.string().nullable(),  // <repo>/config/<dir>/<name>.jsonc
  gitOrigin: z.string().nullable(),    // <repo>/config/<dir>/<name>.origin.jsonc
}),
```

**`plugins/config_v2/server/internal/registry.ts`** — `getRawFileContent()`:
- Keep reading the user-layer files from the registry `entry`
  (`userOverwritesPath`, `userOriginPath`).
- Derive the git-layer paths from the storePath the same way
  `computeAllConflicts` does:
  ```ts
  const parts = storePath.replace(/\.jsonc$/, "").split("/");
  const dir  = parts.slice(0, -1).join("/");
  const name = parts.at(-1)!;
  const gitOverridePath = join(REPO_ROOT, "config", dir, `${name}.jsonc`);
  const gitOriginPath   = join(REPO_ROOT, "config", dir, `${name}.origin.jsonc`);
  ```
  (Import `REPO_ROOT` from `@plugins/infra/plugins/paths/server`; reuse the
  existing `readRaw` helper for all four files.)
- Note: git layer is repo-wide, not scope-forked, so `scopeId` only affects the
  user-layer paths (unchanged behaviour).

### 3. UI: pinpoint the bad field + diff button (web)

**`plugins/config_v2/plugins/settings/web/components/config-detail.tsx`** — invalid
branch (`:151-182`):
- Add a small pure helper `drillPath(root, path)` that walks the structured path
  (string keys / number indices) and returns the value or a `MISSING` sentinel.
- Render each issue as: dotted path (`items.6`) + message (`Invalid input`) + the
  offending value pretty-printed via `HighlightedCode` (or `<code>` for short
  scalars), drilled from `conflictEntry.overrideValues`. Show `(missing)` when
  the path resolves to the sentinel (e.g. required-but-absent keys).
- Add a **View diff** button in the banner action row (mirroring the hash-conflict
  banner's button at `:201-209`) that toggles an `InvalidDiff` panel.

**New `plugins/config_v2/plugins/settings/web/components/invalid-diff.tsx`** —
mirror `ConflictDiff`, but diff *the invalid override that is in effect* against
*the schema defaults*:
- old (left, "Stored (invalid)") = `override ?? gitOverride ?? origin`
- new (right, "Defaults") = `gitOrigin ?? origin`
- Reuse `TextDiff`, same chrome/`max-h-96` container as `ConflictDiff`.

### 4. UI: all layers in the raw view, ordered User → Git → Origin (web)

`RawFileView` (`:250-280`) renders sections in this order, each shown with a
muted "not set" placeholder when its file is absent so the precedence model stays
legible:

1. **User** — `data.override` (`~/.singularity/config/<wt>/<dir>/<name>.jsonc`)
2. **Git** — `data.gitOverride` (`config/<dir>/<name>.jsonc`)
3. **Origin (defaults)** — `data.gitOrigin` (`config/<dir>/<name>.origin.jsonc`)

Each section header names the layer and its on-disk path (muted caption) so the
user can see exactly which file holds the bad data. The propagated user-layer
`origin` (what the running app actually resolves to) is shown as a 4th
**"Resolved origin (app reads)"** section *only when it differs* from `gitOrigin`
— that divergence means a pending `./equin build`/propagation and is the
one case where the extra file is informative; otherwise it's redundant noise.

## Files to modify

| File | Change |
|---|---|
| `plugins/config_v2/core/internal/resource.ts` | Add `configV2ValidationIssueSchema`/type; change `issues` to structured array |
| `plugins/config_v2/core/index.ts` | Export new schema + type |
| `plugins/config_v2/core/internal/tier-logic.ts` | `validationIssues` returns structured issues; keep joined string only for the warn log |
| `plugins/config_v2/plugins/settings/core/internal/endpoints.ts` | Add `gitOverride`/`gitOrigin` to `getConfigRawFile` response |
| `plugins/config_v2/server/internal/registry.ts` | `getRawFileContent` reads git-layer files via `REPO_ROOT` |
| `plugins/config_v2/plugins/settings/web/components/config-detail.tsx` | Structured issue rows w/ offending value + `View diff` toggle; raw view all-layers ordering |
| `plugins/config_v2/plugins/settings/web/components/invalid-diff.tsx` | New: stored-invalid vs defaults `TextDiff` |

Docs: the config_v2 `CLAUDE.md` "Schema evolution" / "Invalid surfacing"
paragraph mentions issues carry "the zod `issues`" — update wording to reflect the
structured shape. `./equin build` regenerates the autogen reference blocks.

## Verification

1. `./equin build` (from the worktree). The bad `config/apps/apps.app.jsonc`
   spacer already provides a live invalid conflict to test against — no fixture
   needed.
2. Open `http://att-1781173983-4v9o.localhost:9000/agents/config/cd/apps%252Fapps.app.jsonc`.
   - Banner lists `items.6 — Invalid input` **with** the offending value
     `{ "spacer": "spacer-1" }` shown inline.
   - **View diff** opens a side-by-side of the stored spacer object vs the clean
     `{ "type": "spacer", "id": … }` defaults.
   - **Raw file** lists User (absent → "not set"), Git
     (`config/apps/apps.app.jsonc`, the invalid override), and Origin
     (`config/apps/apps.app.origin.jsonc`, clean defaults) in that order.
3. Scripted check (one Playwright run):
   ```bash
   bun e2e/screenshot.mjs \
     --url 'http://att-1781173983-4v9o.localhost:9000/agents/config/cd/apps%252Fapps.app.jsonc' \
     --click 'View raw' --out /tmp/config-raw
   ```
4. Sanity on a **valid** config (e.g. a theme token config): no invalid banner;
   raw view shows the layers that exist with correct labels; existing hash-conflict
   diff path untouched.
5. `./equin check` — `config-origins-in-sync` and `eslint` stay green
   (no floating promises, no `string[]`→structured type drift).
