# Enforce agent-authored reorder config overrides

## Context

We now have a per-slot config layer (`config_v2` + the `reorder` primitive) that lets agents
curate the order/visibility of every reorderable UI slot. Each reorderable slot has an
auto-generated origin (`config/<plugin-path>/<slotId>.origin.jsonc`) containing the full
materialized contribution order, and an optional agent-authored override
(`config/<plugin-path>/<slotId>.jsonc`) that curates it.

Today **zero** of the 46 reorderable slots have an authored override — every UI list renders in
arbitrary registration order. The goal is twofold:

1. **Enforce** that a reorderable slot has a deliberate, agent-authored order — so no *new* UI
   list ships with an arbitrary order again.
2. **Populate** the existing slots so agents actually curate the current UI.

### Key design fact: reorder is opt-out

Every `defineRenderSlot()` is reorderable unless it passes `reorder: false`. So "a new reorderable
slot" is effectively "a new render slot." The enforcement therefore puts a deliberate fork in front
of every new render slot: **either** author a curated override **or** declare `reorder: false`
(this list isn't user-reorderable). Both are conscious decisions — that pressure-relief valve is the
point, not a side effect. The check never forces a *meaningful reorder*; it only forces the file to
exist (decision locked with the user: existence is enough, `@hash` freshness is already enforced by
the sibling `config-origins-in-sync` check).

### Locked decisions (from the user)

- **Strictness:** a committed override `config/<path>/<slotId>.jsonc` must EXIST. It need not differ
  from the origin's natural order.
- **Scope:** grandfather all currently-unconfigured slots via a static allowlist; the check fails
  only for slots *not* in the allowlist that lack an override. So it bites for newly-added slots
  only and burns down as the allowlist shrinks.

---

## Deliverable 1 — the enforcement check `reorder:configs-authored`

A plugin-contributed check (auto-discovered, no registry edit needed) at
`plugins/reorder/check/index.ts`.

### Files to create

**`plugins/reorder/check/grandfathered-slots.ts`** — static, hand-maintained allowlist of override
*relative paths* exempt from the requirement. Seeded once with all currently-unconfigured slots,
then only ever shrinks. Mirrors the `no-adhoc-typography` `ignores` array pattern
(`plugins/primitives/plugins/text/lint/index.ts`).

```ts
/**
 * Grandfathered reorder config overrides — slots that existed before
 * reorder:configs-authored and had no override at that time.
 *
 * RULES:
 *  - When an override is authored for a path here, REMOVE the path (the check
 *    fails on redundant entries to force the prune).
 *  - NEVER add new paths. A new reorderable slot must either ship a curated
 *    override or be declared `reorder: false`.
 *  - This list MUST shrink to []; an empty array means full burn-down.
 */
export const grandfatheredSlots: string[] = [
  // seeded — see generator command in the plan
];
```

Seed it once (during implementation) so the paths exactly match the check's own path computation:

```bash
bun -e '
  const { reorderableSlots } = await import("./plugins/reorder/shared/reorderable-slots.generated.ts");
  const { asPath, asPluginId } = await import("./plugins/framework/plugins/plugin-id/core/index.ts");
  const { execSync } = await import("node:child_process");
  const committed = new Set(
    execSync("git ls-files --others --cached --exclude-standard -- config/")
      .toString().trim().split("\n").filter(Boolean),
  );
  const paths = reorderableSlots
    .map((s) => `config/${asPath(asPluginId(s.pluginId))}/${s.slotId}.jsonc`)
    .filter((p) => !committed.has(p))
    .sort();
  console.log(paths.map((p) => `  ${JSON.stringify(p)},`).join("\n"));
'
```

Paste the output into `grandfatheredSlots`. (~46 entries today.)

**`plugins/reorder/check/index.ts`** — the check:

```ts
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { reorderableSlots } from "@plugins/reorder/shared/reorderable-slots.generated";
import { grandfatheredSlots } from "./grandfathered-slots";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

async function getRoot(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe", stderr: "pipe",
  });
  return (await new Response(proc.stdout).text()).trim();
}

const check: Check = {
  id: "reorder:configs-authored",
  description:
    "Every reorderable slot must have a config override (grandfathered slots exempt until authored)",
  async run(): Promise<CheckResult> {
    const root = await getRoot();
    const proc = Bun.spawn(
      ["git", "ls-files", "--others", "--cached", "--exclude-standard", "--", "config/"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const committed = new Set(
      (await new Response(proc.stdout).text()).trim().split("\n").filter(Boolean),
    );
    const grandfathered = new Set(grandfatheredSlots);

    const missing: string[] = [];
    const redundant: string[] = []; // grandfathered, but an override now exists → prune it
    for (const slot of reorderableSlots) {
      const path = `config/${asPath(asPluginId(slot.pluginId))}/${slot.slotId}.jsonc`;
      const hasOverride = committed.has(path);
      const isGrandfathered = grandfathered.has(path);
      if (hasOverride && isGrandfathered) redundant.push(path);
      else if (!hasOverride && !isGrandfathered) missing.push(path);
    }

    if (!missing.length && !redundant.length) return { ok: true };

    const parts: string[] = [];
    if (missing.length)
      parts.push(
        `${missing.length} reorderable slot(s) missing a config override:\n` +
          missing.map((p) => `    ${p}`).join("\n"),
      );
    if (redundant.length)
      parts.push(
        `${redundant.length} grandfathered slot(s) now have an override — remove from grandfathered-slots.ts:\n` +
          redundant.map((p) => `    ${p}`).join("\n"),
      );
    const hint =
      (missing.length
        ? "For each missing slot: copy its .origin.jsonc to .jsonc, curate items, keep the // @hash line, and commit — or set reorder:false on the slot. "
        : "") +
      (redundant.length ? "Remove the listed paths from plugins/reorder/check/grandfathered-slots.ts." : "");
    return { ok: false, message: parts.join("\n\n"), hint: hint.trim() };
  },
};

export default check;
```

### Design notes / decisions baked in

- **`--others --cached --exclude-standard`** (matches `config-origins-in-sync`), *not* `--cached`-only.
  Presence-in-worktree is the requirement; committed-ness is already guaranteed by push's
  dirty-tree gate. `--cached`-only would fail `build` the instant an agent writes an override but
  before staging it.
- **Redundancy failure (YES):** the check fails when a grandfathered path now has an override,
  forcing the allowlist to shrink. Without it the list silently rots and never reaches `[]`. The
  repair is one trivial edit, with an exact pointer in the message — same ergonomics as any
  allowlist burn-down.
- **No `cacheSignature`:** omit it. The check reads only committed files + the allowlist (both
  captured by the runner's tree hash). Identical caching posture to `config-origins-in-sync` and
  `reorderable-slots-in-sync`.
- **Path computation:** `asPath` transforms only the `pluginId` (dot→slash); `slotId` stays literal
  in the filename. Confirmed against on-disk layout, e.g. slot `debug-app.toolbar` /
  pluginId `apps.debug.shell` → `config/apps/debug/shell/debug-app.toolbar.jsonc`.
- **Import boundary:** `check/` importing `reorder/shared/` is a same-plugin internal import (legal,
  same as `web/`/`server/` importing `shared/`).
- **Minor known gap:** if a slot is later *removed* from the manifest, its path may linger as a dead
  allowlist entry. Harmless (the check iterates current slots, not the allowlist); documented in the
  allowlist header. Not worth extra code.

### Critical files

- CREATE `plugins/reorder/check/index.ts`
- CREATE `plugins/reorder/check/grandfathered-slots.ts`
- READ-ONLY `plugins/reorder/shared/reorderable-slots.generated.ts` (slot source of truth)
- REFERENCE `plugins/framework/plugins/tooling/plugins/checks/plugins/config-origins-in-sync/check/index.ts`
  and `.../reorderable-slots-in-sync/check/index.ts` (check style + git-spawn pattern)
- AUTO-UPDATED by `./equin build`: the check collected-dir registry (do not hand-edit)

---

## Deliverable 2 — populate the overrides (burn down the allowlist)

This is the "have agents actually order them" half. It runs **after** the check lands (the check is
green immediately because every slot is grandfathered). It is operator-triggered, not part of the
check. Best executed as a multi-agent **Workflow** (requires explicit user opt-in to run).

### Workflow shape

`pipeline` over the grandfathered slots, batched ~4-5 slots per agent (~10 agents):

1. **Enumerate (instant):** read `reorderableSlots` + `grandfatheredSlots`; for each pending slot
   read its `config/<path>/<slotId>.origin.jsonc` to capture the `// @hash <h>` line and the full
   `items` entryKey list. Build a payload per slot: `{ overridePath, originPath, hash, items[],
   slotDescription }`. Derive `slotDescription` from the contributing plugins' descriptions
   (`docs/plugins-compact.md` / per-plugin `CLAUDE.md`); each entryKey is `pluginId:id`.

2. **Author (parallel):** each agent, per slot, writes `overridePath` =
   - line 1: `// @hash <h>` copied **verbatim** from the origin (config-origins-in-sync requires it),
   - body: `{ "items": [...] }` — a curated reorder of the origin's entryKeys, optionally marking
     low-salience items `{ "item": "<key>", "hidden": true }`.

   **Hard constraint (in the agent prompt):** the keys in `items` must be exactly the origin's
   entryKeys — reorder freely, hide freely, but never invent or drop a key (hidden still counts as
   present). Distinct files → no write conflicts. Returns the list of paths it wrote.

3. **Prune (sequential, orchestrator only):** remove every authored path from `grandfatheredSlots`
   in `plugins/reorder/check/grandfathered-slots.ts`. Single-writer step — agents must not touch the
   shared allowlist (would conflict).

4. **Validate:** `./equin build` → `./equin check reorder:configs-authored` →
   `./equin check config-origins-in-sync`. If the latter flags a stale `@hash` (origin shifted
   during a concurrent build), reconcile by re-copying the new origin hash into the override.

### Output-quality guards

- Invented entryKey → silently skipped at runtime (`applyTree` ignores unknown names) but leaves a
  phantom entry. Orchestrator post-validates: every key in a written override must appear in that
  slot's origin `items`.
- Omitted entryKey → still rendered (appended in natural order) but uncurated. Same post-validation
  catches it (non-hidden origin keys absent from the override).

---

## Verification

**Check fails for a new slot:** temporarily add `{ slotId: "test.fake", pluginId: "welcome" }` to the
manifest (or add a real `defineRenderSlot` and `./equin build`). Run
`./equin check reorder:configs-authored` → FAIL listing `config/welcome/test.fake.jsonc` with
the author-or-`reorder:false` hint. Revert.

**Check passes once authored:** create `config/welcome/test.fake.jsonc` (copy its `.origin.jsonc`,
keep `@hash`), `git add` it → check passes.

**Redundancy path:** pick a path in `grandfatheredSlots`, create + `git add` its override → check
FAILs demanding the allowlist prune; remove the path → passes.

**Escape hatch:** set `reorder: false` on a slot → it leaves the manifest after `./equin build`
→ no override required.

**Full burn-down (after Deliverable 2):** `grandfatheredSlots` is `[]`;
`./equin check reorder:configs-authored` and `config-origins-in-sync` both green.
