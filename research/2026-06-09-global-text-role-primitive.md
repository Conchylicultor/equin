# Plan: `<Text role>` typography primitive + `no-adhoc-typography` lint

## Context

Our app looks generic/"ugly" not because of color (we already have a `tokens/typography` group + theme presets) but because hierarchy, weight, and size are unenforced: every plugin hand-writes raw Tailwind (`text-sm font-medium leading-6`), so ~95 conversation sub-plugins each invent slightly different typography and a theme swap only repaints color over flat bones. Professional systems (Material, Apple HIG, Primer) don't expose raw sizes — they expose a small closed set of **semantic roles**, each a frozen bundle of size+line-height+weight+tracking, and enforce that you pick a role, not a size.

This is **item 1 of 3** of the structural fix and the **proof-of-pattern** the other two tasks mirror (surface/elevation `task-…yr8t2g`, spacing `task-…qecam7`). It establishes the shape: **typed primitive + themeable tokens + lint rule that makes the raw form a build error** — exactly the precedent already proven by `control-size`/`no-adhoc-control` and `z-layers`/`no-adhoc-zindex`.

Deliverable: a `<Text role tone as>` component backed by new themeable role tokens in `tokens/typography`, a `no-adhoc-typography` ESLint rule (sizes + leading), and a migration of the conversation transcript for a visible before/after.

## Decisions (locked)

- **6 roles** — `title, heading, subheading, body, label, caption`. Markdown `h1` folds into `title`.
- **Lint v1 bans font-SIZE named steps + `leading-*` only** — weight/tracking/color deferred. Ships repo-wide as `error` with a mechanically-generated `ignores` allowlist of current offenders (mirrors `no-arbitrary-font-size`); the two migrated files are excluded so they're enforced.
- **Role tokens live in the `tokens/typography` group** (single source of truth, runtime-themeable via presets), not static in the primitive.
- **Prop name `role`** (shared vocabulary; we never spread a DOM/ARIA `role`). Default `as="span"`.
- **Build-breaker avoided**: role `@utility` classes read `--font-size-<role>`/`--line-height-<role>` **directly** — do NOT add `--text-<role>` bridges to `@theme inline` (that auto-generates a colliding `text-<role>` utility).

## The role set

| Role | size | line-height | weight | tracking | Replaces | Transcript use |
|------|------|-------------|--------|----------|----------|----------------|
| `title` | 1.25rem | 1.75rem | 600 | -0.01em | `text-xl font-semibold` | markdown h1, h2 |
| `heading` | 1.125rem | 1.625rem | 600 | -0.005em | `text-lg font-semibold` | markdown h3 |
| `subheading` | 1rem | 1.5rem | 600 | 0 | `text-base font-semibold` | markdown h4 |
| `body` | 0.875rem | 1.5rem | 400 | 0 | `text-sm leading-6` | assistant/user prose |
| `label` | 0.8125rem | 1.25rem | 500 | 0 | `text-sm font-medium` | UI labels |
| `caption` | 0.75rem | 1rem | 400 | 0 | `text-xs` | metadata |

Weights reuse existing `--font-weight-*` tokens (zero new weight tokens). Tracking inlined as literals in the `@utility`. `text-2xs`/`text-3xs` stay as sanctioned sub-scale (badges/chips), below role granularity. **mono/code is out of scope** — code blocks have their own components (`HighlightedCode`, markdown `code` override); roles omit a `code` member and the lint rule must not touch `font-mono`.

## Implementation

### 1. Extend the typography token group (themeable, single-source)

**`plugins/ui/plugins/tokens/plugins/typography/shared/group.ts`** — add 12 schema entries (camelCase → `--kebab` vars): `fontSize{Title,Heading,Subheading,Body,Label,Caption}` + `lineHeight{…}` with the defaults from the table. `defineTokenGroup` derives `--font-size-title` … `--line-height-caption`.

**`plugins/ui/plugins/tokens/plugins/typography/web/presets.ts`** — add the same 12 key/value pairs to `defaultPreset` (inside `both({…})`). `TypographyTokenValues = {[K in keyof schema]: string}` makes this a **compile error until updated** (good). Audit `tweakcn` / any other `Typography.Preset` producer for partial value objects — `ThemeInjector.buildVarsBlock` only emits keys present in the active preset, so a missing key = role falls back to nothing.

### 2. Tailwind CSS (`plugins/framework/plugins/web-core/web/theme/app.css`)

Add 6 `@utility` role bundles near the existing `control-*` utilities (~line 312), each reading the runtime vars directly:

```css
@utility text-title      { font-size: var(--font-size-title);      line-height: var(--line-height-title);      font-weight: var(--font-weight-semibold); letter-spacing: -0.01em; }
@utility text-heading    { font-size: var(--font-size-heading);    line-height: var(--line-height-heading);    font-weight: var(--font-weight-semibold); letter-spacing: -0.005em; }
@utility text-subheading { font-size: var(--font-size-subheading); line-height: var(--line-height-subheading); font-weight: var(--font-weight-semibold); }
@utility text-body       { font-size: var(--font-size-body);       line-height: var(--line-height-body);       font-weight: var(--font-weight-normal); }
@utility text-label      { font-size: var(--font-size-label);      line-height: var(--line-height-label);      font-weight: var(--font-weight-medium); }
@utility text-caption    { font-size: var(--font-size-caption);    line-height: var(--line-height-caption);    font-weight: var(--font-weight-normal); }
```

**Do NOT add `--text-<role>` entries to `@theme inline`** (collision). This mirrors `control-xs { height: var(--control-height-xs); }` exactly — picking a typography preset re-themes roles live.

### 3. New primitive `plugins/primitives/plugins/text/`

Mirror `section-label`'s layout:
- `package.json` — `@singularity/plugin-primitives-text`, `private`, `version 0.0.1`, `description` (root field only).
- `CLAUDE.md` — prose + the role table.
- `web/internal/text.tsx`:
  ```tsx
  export type TextRole = "title" | "heading" | "subheading" | "body" | "label" | "caption";
  export type TextTone = "default" | "muted" | "primary" | "destructive";
  // ROLE_CLASS: role -> "text-<role>";  TONE_CLASS: muted->text-muted-foreground, primary->text-primary, destructive->text-destructive, default->""
  export function Text({ role, tone="default", as:As="span", className, children, ...rest }: TextProps) {
    return <As className={cn(ROLE_CLASS[role], TONE_CLASS[tone], className)} {...rest}>{children}</As>;
  }
  ```
  Composition order `cn(role, tone, className)` — caller className wins last (layout margins). `cn` from `@/lib/utils`.
- `web/index.ts` — barrel: re-export `Text`/types; `export default { description, contributions: [] } satisfies PluginDefinition` (plain object, not `definePlugin()`).

### 4. Lint rule (co-located: `plugins/primitives/plugins/text/lint/`)

- `no-adhoc-typography.ts` — copy the `no-arbitrary-font-size.ts` skeleton (`collectClassNodes`, `CLASS_ATTRS`/`CLASS_BUILDERS`, `JSXAttribute`+`CallExpression` visitors, last-`:` variant-prefix stripping). Fire on **any element**. Per token, after stripping variants, test:
  - `SIZE = /^text-(?:xs|sm|base|lg|xl|[2-9]xl)$/` — matches named size steps only, **never** color classes (`text-muted-foreground`) or sub-scale (`text-2xs/3xs`).
  - `LEADING = /^leading-/`
  - No autofix. Message points to `<Text role>` (`@plugins/primitives/plugins/text/web`), notes `text-2xs/3xs` stay for chips.
- `lint/index.ts` — `export default { name: "text", rules: { "no-adhoc-typography": rule }, ignores: { "no-adhoc-typography": [ ...baseline ] } }`.
- **Baseline allowlist** — generate mechanically (read-only), then hand into `ignores`:
  ```
  rg -l -e 'text-(xs|sm|base|lg|xl|[2-9]xl)\b' -e '\bleading-' plugins --glob '*.tsx' --glob '*.ts' \
    | sort | grep -vE 'assistant-text-row\.tsx|markdown/web/internal/base-components\.tsx'
  ```
  Exclude the 2 migration targets and the rule's own file. **Expect ~300-600 files** — large but one-line-per-file and the only way to land an `error`-level rule without a thousand-edit sweep (precedent: `no-arbitrary-font-size` allowlists ~94). Legacy burns down incrementally; new code is blocked immediately.

### 5. Migrate the transcript (before/after)

- `…/jsonl-viewer/plugins/assistant-text/web/components/assistant-text-row.tsx`: `import { Text } from "@plugins/primitives/plugins/text/web"`. Line 23 `<div className="text-sm leading-6">` → `<Text as="div" role="body">`. Line 51 `<div className="whitespace-pre-wrap break-words text-sm">` → `<Text as="div" role="body" className="whitespace-pre-wrap break-words">`.
- `plugins/primitives/plugins/markdown/web/internal/base-components.tsx`: headings → `<Text>` keeping margins:
  - `h1` `text-2xl font-semibold` → `<Text as="h1" role="title" className="mt-4 mb-2">`
  - `h2` `text-xl font-semibold` → `<Text as="h2" role="title" className="mt-4 mb-2">`
  - `h3` `text-lg font-semibold` → `<Text as="h3" role="heading" className="mt-3 mb-1.5">`
  - `h4` `font-semibold` → `<Text as="h4" role="subheading" className="mt-3 mb-1">`
  - Keep the `transform(children)` child. Leave `p`/`li`/`code`/`a`/`table`/`blockquote` untouched (p inherits body; code out of scope).
- **Visible improvement** (not pure no-op): the role bundles give large headings deliberate negative tracking + consistent line-heights, tightening the heading ladder vs. today's flat `text-xl`/`text-lg`. Call this out in the screenshot.

## Critical files
- `plugins/ui/plugins/tokens/plugins/typography/shared/group.ts` — +12 schema entries
- `plugins/ui/plugins/tokens/plugins/typography/web/presets.ts` — +12 preset values (compile-enforced)
- `plugins/framework/plugins/web-core/web/theme/app.css` — +6 `@utility` role bundles
- `plugins/primitives/plugins/text/{package.json,CLAUDE.md,web/index.ts,web/internal/text.tsx,lint/index.ts,lint/no-adhoc-typography.ts}` — new plugin
- `plugins/ui/plugins/tokens/plugins/typography/lint/no-arbitrary-font-size.ts` — copy template
- `…/jsonl-viewer/plugins/assistant-text/web/components/assistant-text-row.tsx` + `plugins/primitives/plugins/markdown/web/internal/base-components.tsx` — migration

## Verification
1. `./equin build` — codegen discovers the new `lint/index.ts`; Tailwind v4 fails the build on a bad `@utility`, so a green build confirms the CSS compiles and the barrel typechecks.
2. **Before/after** — `http://<worktree>.localhost:9000`, open a conversation whose assistant text has `##`/`###` headings (markdown mode on). Screenshot before vs. after via `e2e/screenshot.mjs`; expect tighter heading hierarchy, unchanged body.
3. **Lint fires** — temporarily add `text-sm` to the migrated `assistant-text-row.tsx`, run `./equin check` (eslint) → expect a `no-adhoc-typography` error. Remove it.
4. **Repo green** — full `./equin check` reports zero `no-adhoc-typography` errors (all migrated or allowlisted), and confirm the 2 migration targets are absent from `ignores`.

## Follow-ups (out of scope)
- Burn down the allowlist subtree-by-subtree (more transcript rows, sidebar, toolbar).
- v2: extend the rule to `font-*` weight + `tracking-*` once `<Text>` adoption is broad.
- Surface/elevation (`task-…yr8t2g`) and spacing (`task-…qecam7`) mirror this exact primitive+token+lint shape.
