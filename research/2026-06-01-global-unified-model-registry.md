# Unified model registry — single source of truth for Claude models

## Context

On 2026-06-01, commit `4a1e46994 feat(model)` changed the `ConversationModel` enum
from `opus`/`sonnet` to versioned ids (`opus-4-8`, `sonnet-4-6`, …). That one change
required **four** follow-up fix commits (`9a09aec0`, `db7219ee`, `d6e10504`, plus a
backfill migration) and still left duplicated model knowledge scattered across the
tree. The breakage exposed three structural faults:

1. **The enum value *is* the persisted DB value, with no decoupling.** Changing the
   enum instantly invalidated every existing row; the data migration was a separate,
   hand-authored concern that was forgotten.
2. **Array resources parse atomically client-side.** A single row with a stale model
   value threw a `ZodError` at `notifications-client.ts:246` (the WS push path, where
   the throw is *uncaught*), leaving the TanStack cache at its `initialData` (`[]`) —
   blanking the entire conversation sidebar and every working/waiting indicator.
3. **"Model" is defined in ≥5 independent places** that must be hand-synced: the
   registry, a parallel `ClaudePrintModel` enum + flag map in `claude-cli` (already
   drifted), a hardcoded `SUMMARY_MODEL` flag, a `canonicalModel` regex in `stats/cost`,
   family color maps duplicated across two UI files, and filter chips in a debug pane.

**Intended outcome:** one registry that every model consumer resolves through; a
persisted model field that tolerates legacy/unknown values *by construction* (so a
future enum change can never blank the UI); and a `./equin check` that prevents
agents from reintroducing the drift. Changing the model set should touch exactly one
file.

## Design

Two genuinely distinct caller needs must both route through the one registry:

- **Versioned selection** — full Claude Code sessions (`createConversation`,
  auto-start, agents, task-draft) let the user pick and *persist* a specific
  `ConversationModel` id (`opus-4-8`). Already registry-based.
- **Capability tier** — one-shot `claude --print` background calls (turn-summary,
  category classify, task-title, summary worker) want a *tier* ("cheap/fast" = haiku,
  "smart" = opus) and must **not** pin a version. Today they pass `"haiku"|"sonnet"|"opus"`
  to a parallel enum. They should ask the registry for "the current model of tier X".

The registry becomes the single owner of: the id set, each id's CLI flag, family/tier,
label, the per-tier "current" model, the reverse CLI-name→id map, and family styling.

## Part 1 — Unified registry (the single source of truth)

**File:** `plugins/conversations/plugins/model-provider/core/registry.ts`

- Add a `haiku-4-5` entry so print callers resolve through the registry. Mark
  print-only entries with `printOnly?: true` so they're excluded from the launch
  dropdown / config options (they remain valid persisted ids but aren't session-selectable).
- Treat `family` as the **tier** axis and extend it to `"haiku" | "sonnet" | "opus"`.
- Add core helpers (pure, importable everywhere; keep model-provider/core zero-dep):
  - `cliFlagFor(id: ConversationModel): string` — id → CLI flag (the one map).
  - `currentModelForTier(tier): ConversationModel` — the non-`defaultHidden`,
    non-`printOnly`(except haiku) id for a tier (opus→`opus-4-8`, sonnet→`sonnet-4-6`,
    haiku→`haiku-4-5`). Used by print callers.
  - `idForCliName(name: string): ConversationModel | null` — reverse lookup that strips
    a trailing date suffix (`claude-opus-4-7-20250101` → matches `opus-4-7`). Replaces
    the `canonicalModel` regex.
  - `MODEL_TIERS: readonly ["haiku","sonnet","opus"]` — drives filter chips.

**Web styling helper** (new internal file in `model-provider/web`, exported from its
web barrel): `familyClass(family): string` — the CSS class map, owned once. Consumed by
`model-badge.tsx:5` and `launch-prompts-button.tsx:15` (delete both local `FAMILY_*` maps).

## Part 2 — Fold every parallel definition into the registry

- **`claude-cli`** (`plugins/infra/plugins/claude-cli/server/internal/run-claude-print.ts`):
  delete `ClaudePrintModel` and `MODEL_IDS`. `RunClaudePrintInput` takes
  `tier: "haiku"|"sonnet"|"opus"`; resolve via `cliFlagFor(currentModelForTier(tier))`.
  Log the **resolved id** (not the tier) so the debug pane shows the exact version.
  Import `model-provider/core` (zero-dep → no cycle).
  - Update the 3 callers to pass `tier:` — `turn-summary/job.ts:94`,
    `conversation-category/classify-job.ts:106`, `task-title/generate-title.ts:35`.
  - `claude-cli/core/resources.ts:7`: change `model: z.enum(["haiku","sonnet","opus"])`
    to the tolerant stored-model schema (Part 3) since it now stores a registry id.
  - `claude-cli-calls/web/components/calls-view.tsx`: derive the filter chips from
    `MODEL_TIERS` instead of the hardcoded type + literals.
- **summary worker** (`summary/server/internal/mcp-tools.ts:10`): replace
  `SUMMARY_MODEL = "claude-sonnet-4-6"` with a registry id constant; resolve the flag
  via `cliFlagFor`. (`handle-generate.ts:34` already passes a registry id `sonnet-4-6` —
  keep, but source it from the registry constant.)
- **stats/cost**: replace `canonicalModel` (`load-usage.ts:312`) with `idForCliName`,
  and `modelFamily` (`handlers.ts:4`) with `MODEL_REGISTRY[id].family`. Keep a graceful
  fallback for ids the registry doesn't know (historical usage names).

## Part 3 — Tolerant stored-model field (root fix for the blanking)

Make the persisted model representation tolerant **by construction** so a legacy/unknown
value normalizes instead of rejecting the payload — removing the need for the bolted-on
preprocess and the per-query normalize calls.

- **New helper** `tolerantEnum<T>(schema, normalize): z.ZodType<T>` in
  `plugins/primitives/plugins/live-state/core` (the boundary that owns resource schemas;
  reusable for any future evolving persisted enum). Built with the **`z.union(...) as
  z.ZodType<T>`** pattern (mirrors `RankSchema` in `plugins/primitives/plugins/rank/core/internal/rank.ts:34`)
  so `_input === _output === T` and it slots into object fields + `resourceDescriptor`
  without the `z.preprocess` `_input=unknown` problem:

  ```ts
  export function tolerantEnum<T extends string>(
    schema: z.ZodType<T>,
    normalize: (raw: string) => T,
  ): z.ZodType<T> {
    return z.union([schema, z.unknown().transform((v) => normalize(String(v)))])
      as unknown as z.ZodType<T>;
  }
  ```

- **Apply at the field**, not as a wrapper. In the file defining `ConversationSchema`
  (`plugins/tasks-core/server/internal/schema.ts`), change the `model` field to
  `tolerantEnum(ConversationModelSchema, normalizeModel)`. tasks-core already imports
  both `normalizeModel` and live-state, so model-provider/core stays zero-dep.
- **Delete the now-redundant ad-hoc tolerance**:
  - `StoredConversationSchema` preprocess wrapper in `tasks-core/core/schemas.ts:23-32`
    (use `ConversationSchema` directly in the resource arrays).
  - the read-time `normalizeModel` mapping in
    `tasks-core/server/internal/queries/conversations.ts` (`queryConversations` +
    `getConversation`) — the field tolerates on parse now.
  - Keep the **write-side** `normalizeModel` in `conversations/server/internal/lifecycle.ts`
    (writes should still store canonical values).
- Apply the same `tolerantEnum` to the `claude-cli` call-log model field (Part 2) and
  the auto-start side-table read path if it surfaces in a resource.

> Per the confirmed decision, this is **field-level tolerance only** — we do NOT wrap
> all array resources. Evolving persisted enums opt into tolerance explicitly; every
> other field still fails loudly, preserving the "never silence errors" rule.

## Part 4 — Enforcement check (prevents reintroduction)

**New plugin-contributed check:** `plugins/conversations/plugins/model-provider/check/index.ts`
(default-export `Check`, id `model-provider:no-raw-model-flags`, discovered automatically —
no registry edit). Model it on `no-raw-websocket`
(`.../checks/core/...` — `git grep` template):

- `git grep -nE "claude-(opus|sonnet|haiku)-[0-9]"` over `*.ts`/`*.tsx`.
- Allowlist only `model-provider/core/registry.ts` (and the check file itself).
- Fail with the offending `file:line`s and a hint pointing at `cliFlagFor` /
  `currentModelForTier`.

Scope the check to the unambiguous **CLI-flag literals** (`claude-opus-4-8`, …); bare
`"opus"`/`"sonnet"` literals are intentionally left alone (they're also legitimate
`family`/tier tokens, so grepping them is noisy and low-value).

## Critical files

| File | Change |
|---|---|
| `model-provider/core/registry.ts` | add haiku tier, `printOnly`, `cliFlagFor`, `currentModelForTier`, `idForCliName`, `MODEL_TIERS` |
| `model-provider/web/**` (new) + barrel | `familyClass` helper |
| `model-provider/check/index.ts` (new) | enforcement check |
| `infra/plugins/claude-cli/server/internal/run-claude-print.ts` | drop `ClaudePrintModel`/`MODEL_IDS`; take `tier`, resolve via registry, log resolved id |
| `infra/plugins/claude-cli/core/resources.ts` | model field → tolerant stored-model schema |
| `primitives/plugins/live-state/core/**` + barrel | `tolerantEnum` helper |
| `tasks-core/server/internal/schema.ts` | `model` field uses `tolerantEnum` |
| `tasks-core/core/schemas.ts` | delete `StoredConversationSchema` wrapper |
| `tasks-core/server/internal/queries/conversations.ts` | delete read-time normalize |
| `stats/cost/server/internal/load-usage.ts` + `handlers.ts` | use `idForCliName` + registry family |
| `summary/server/internal/mcp-tools.ts`, `handle-generate.ts` | registry-sourced summary model |
| `turn-summary/job.ts`, `classify-job.ts`, `generate-title.ts` | pass `tier:` |
| `model-badge.tsx`, `launch-prompts-button.tsx`, `calls-view.tsx` | consume registry helpers, delete local maps |

Reused precedents: `RankSchema` union-cast (`rank/core/internal/rank.ts:34`),
`no-raw-websocket` check, `rankText` custom column, plugin-contributed checks
(`infra/plugins/endpoints/check/index.ts`).

## Verification

1. `./equin build` — migrations regenerate cleanly, server restarts. (No enum
   *values* change here, so no new data migration is expected; confirm
   `./equin check --migrations-in-sync` is green.)
2. `./equin check` — the new `model-provider:no-raw-model-flags` check passes;
   temporarily hardcode a `claude-opus-4-8` literal in a scratch file and confirm it
   **fails**, then revert.
3. **Blanking regression** (the core bug): with the app running, use
   `mcp__singularity__query_db` to confirm the conversations list renders, then simulate
   a stale row —
   `UPDATE _conversations SET model='opus' WHERE id=<one row>` is rejected at the DB
   (mutations blocked), so instead unit-test `tolerantEnum`: parse a payload containing
   `{model:'opus'}` and `{model:'totally-unknown'}` and assert both normalize (to
   `opus-4-6` and `DEFAULT_MODEL`) and the array still contains every row. Confirm in the
   UI that the sidebar is fully populated.
4. **Tier resolution**: trigger a turn-summary / category classify (send a turn in any
   conversation) and confirm via the `claude-cli-calls` debug pane that the logged model
   is the resolved registry id (`haiku-4-5`), and the call succeeded.
5. **Cost**: open the stats/cost view and confirm historical model names still group by
   family (no `undefined` families for unknown historical ids).
6. Screenshot the conversation sidebar + a model badge via `e2e/screenshot.mjs` to
   confirm family coloring is unchanged.
