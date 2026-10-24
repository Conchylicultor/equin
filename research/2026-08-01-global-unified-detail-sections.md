# Unified detail sections: one collapsible-section primitive for every detail pane

## Context

A detail pane should be **one render slot whose sections are contributions**, with the host
owning the chrome — the shape Sonata's right-hand panel column already has ("Chord
progression", "Circle of fifths", …).

Today it is five reinventions of that shape:

1. **`primitives/detail-sections`** (`defineDetailSections`) — the intended primitive, used by
   8 panes, but with **two divergent modes**: flat (host paints no chrome; `label` is never
   rendered) and `collapsible: true` (host paints a titled card; `label` *is* the title). Same
   API call, opposite contract.
2. **`Sonata.Section`** + `library/web/components/section-pane.tsx` — the best host. Adds
   `icon`, `actions`, `useAvailable`, and persisted per-section open state, and delegates chrome
   to the `SectionCard` primitive. Not built on the factory.
3. **`Deploy.Section`** + `deploy/plugins/servers/web/panes.tsx` — hand-rolled
   `Surface level="raised"` + `<h2>` card.
4. **`WorkflowsDetail.Section`** + `definitions/web/components/definition-detail.tsx` — literal
   copy-paste of #3, down to the same eslint-disable comment.
5. **Inside flat mode**: 8 of 11 `TaskDetail` sections independently hand-roll their own
   `Collapsible` + `SectionHeaderRow variant="eyebrow"`, and all 16 `PluginView` sections paint
   their own `<h2>` through a shared helper.

Consequences visible today: the deploy server pane is four regions across three slot mechanisms
and three different card treatments plus a hardcoded form; `detail-sections`' collapsible branch
duplicates `SectionCard` near byte-for-byte; and the contribution type carries a `summary` prop
that four `review` sub-plugins set and **no host ever renders**.

The original design doc (`research/2026-05-10-primitives-detail-sections.md`) explicitly deferred
Deploy as "0 current contributors, no urgency". It has since grown one, and its ad-hoc host became
the template Workflows copied. This plan closes that.

**Outcome:** one primitive, one chrome, every detail pane a single slot. The migration is
net-subtractive — the 24 components that currently paint their own titles get smaller.

## The target contract

`plugins/primitives/plugins/detail-sections/web/internal/define-detail-sections.tsx` becomes a
single-mode factory. `DetailSectionsOptions.collapsible` / `.defaultOpen` are deleted.

```ts
export interface DetailSection<EntityProps> {
  label: string;
  component: ComponentType<EntityProps>;
  /** Leading icon in the header row. Raw component; the row owns size + color. */
  icon?: ComponentType<{ className?: string }>;
  /** Header-right controls, reachable while collapsed. Rendered at `sm` density. */
  actions?: ComponentType<EntityProps>;
  /** Collapsed-state preview beside the title (a count, a +/− diff stat). */
  summary?: ComponentType<EntityProps>;
  /** Gate hook. `false` ⇒ nothing painted at all — no card, no title. */
  useAvailable?: (props: EntityProps) => boolean;
  /** First-render open state when the user has no persisted choice yet. */
  useDefaultOpen?: (props: EntityProps) => boolean;
  /** `"none"` opts out of the card entirely — for a pane's identity block. */
  chrome?: "card" | "none";
}
```

Every field is justified by an existing consumer: `icon` (9 Sonata sections), `actions` (3 Sonata
+ the 2 theme-customizer `headerExtra` contributors, which fold onto this name), `summary` (3
`review` sections, currently dead), `useAvailable` (7 Sonata sections), `useDefaultOpen` (deploy's
SSH card: open until the connection verifies), `chrome: "none"` (see Open decision).

`headerExtra` is removed in favour of `actions` — same role, and `actions` matches both
`SectionCardProps` and `SonataSection`.

### Host rules

- **Chrome is `SectionCard`, always.** The collapsible branch's hand-inlined
  `Collapsible`/`div.rounded-lg`/`SectionHeaderRow` is deleted and replaced by
  `<SectionCard title icon actions open onOpenChange>`. This also fixes three silent drifts the
  inlined copy had: no `bg-card`, no `shadow-sm`, translucent `border-border/60` instead of the
  `Card` token, and no Ctrl+A select-scope.
- **Open state** resolves: persisted user toggle → `useDefaultOpen?.()` → `false`. Persistence is
  `useDraft` (localStorage, 7-day TTL refreshed on write) under
  `` `${slotId}.${sectionId}.open` ``, where `slotId` is the factory's own `${id}.section` — so
  two panes' sections can never collide. Mirrors Sonata's `sonata.section.<id>.open` key exactly.
- **`useAvailable` gates before any paint.** Copy Sonata's `GatedSection` split verbatim
  (`section-pane.tsx:49-64`): the host branches once on the hook's *presence*, which is stable per
  contribution, so both leaves stay rules-of-hooks clean.
- **A collapsed body is genuinely unmounted** (`CollapsibleContent` returns `null`). Work that
  must outlive the panel belongs in a `defineMountSlot` headless contribution, not the body. Say
  so in the primitive's docblock — this is the trap Sonata already hit.
- **Pane gutter: padding and flush must move together.** `SectionCard` supplies `px-lg` on its
  body but does **not** apply `pane-gutter-flush`; today's `detail-sections` applies both. The new
  host must re-apply `pane-gutter-flush` on the wrapper it passes into `SectionCard`, or every
  `DataView` inside a section double-gutters. Drop the class without also dropping the padding and
  DataViews go flush to the card edge instead.

### Slot-id preservation (load-bearing)

`reorderDirectiveDescriptor(slotId)` uses the slot id **verbatim** as its config_v2 config name
(`config/<plugin>/<slotId>.jsonc`). Renaming a slot silently resets every persisted section order
on that pane. `defineDetailSections(id)` emits `${id}.section`, so choose ids that reproduce the
existing string:

| Pane | Factory id | Emitted slot id | Existing id | Order survives |
|---|---|---|---|---|
| Sonata | `"sonata"` | `sonata.section` | `sonata.section` | yes |
| Workflows | `"workflows.detail"` | `workflows.detail.section` | `workflows.detail.section` | yes |
| Pages | `"pages.detail"` | `pages.detail.section` | `pages.detail.section` | yes |
| Deploy | `"deploy.server-detail"` | `deploy.server-detail.section` | `deploy.section` | **no** (1 contributor — accepted) |

## Migration

Ordered so the primitive lands first and each pane is independently shippable.

### Phase 1 — the primitive

Rewrite `define-detail-sections.tsx` to the contract above; delete the two-branch `Host`. Add the
`summary` render (beside the title, visible while collapsed) — it is already set by three `review`
sections and dropped on the floor today.

### Phase 2 — the two systemic contributor fixes

Both are single-point, and both **delete** code:

- **`plugin-meta/plugin-view`** — `web/components/section.tsx`'s shared `Section` helper paints
  the `<h2>` for all 16 contributors. Strip the title from that helper (keep the count affordance,
  which becomes a `summary`), and every contributor is content-only with no per-plugin edit.
- **`tasks/task-*`** — 8 sections (`task-description`, `task-effort`, `task-preprompt`,
  `task-dependencies` ×2, `task-attachments`, `pages/prompt-origin`, and `task-events`' two
  nested blocks) drop their own `Collapsible` + `SectionHeaderRow`, keeping only the body. Header
  actions they render move to the contribution's `actions`.

Also: `build/build-profiling` self-wraps a bordered card + a "Build" `GanttSection` title — strip
the outer `Clip` border and the duplicate title. `tasks/task-graph` self-wraps a bordered card with
no title — it becomes `chrome: "none"`, since a graph canvas is not a titled panel.

No contributor changes needed for `TableDetail` (5), `ReleaseDetail` (3), `CompositionDetail` (7),
`ThemeCustomizer` (11 — their nested sub-collapsibles are internal, not duplicates), `Review`
bodies (3), or Sonata (9).

### Phase 3 — absorb Sonata's host

`sonata/library/web/components/section-pane.tsx` keeps only the collapse-to-rail column chrome;
`SectionCardHost` / `GatedSection` / `Section` are deleted (they now live in the primitive).
`Sonata.Section` becomes `defineDetailSections<{}>("sonata")`, preserving the slot id.

`area: "editor" | "player"` stays a contribution field and remains a **render-time filter** in the
two `.Render subId=…` calls — `subId` does not partition reorder (persisted layout is keyed by base
slot id only), so this is unchanged behaviour, not a regression. Keep the `subId` values so the
zones stay distinguishable to reorder's per-zone measurement.

### Phase 4 — the ad-hoc hosts

- **Workflows** — replace the `Surface`+`<h2>` block in `definition-detail.tsx` with
  `<WorkflowsDetail.Host definitionId={…}/>`; rename the contribution's `title` → `label`.
- **Pages** — `PageDetail.Section` has **no `label` field today**. Add one, move the titles out of
  `Backlinks` ("Linked from") and `StorySection` ("Story") onto the contributions, and strip their
  self-painted `SectionLabel`s.
- **Deploy** — see below.

### Phase 5 — deploy server detail

The pane becomes four peer sections in one slot. New slot, owned by `servers` (not the app shell —
its props are `{ server }`, so it was never an app-level concern):

```ts
// plugins/apps/plugins/deploy/plugins/servers/web/slots.ts
export const ServerDetail = defineDetailSections<{ server: Server }>("deploy.server-detail");
```

- `Deploy.Section` (in `deploy/plugins/shell/web/slots.ts`) is **deleted**; `deployments`
  contributes to `ServerDetail` instead, as `{ id: "deployments", label: "Deployments" }`.
- `Servers.SshSetup` is **deleted**; `ssh-setup` contributes
  `{ id: "ssh-setup", label: "Set up SSH access", useDefaultOpen: () => !verified }` and drops the
  `SectionCard` it currently self-wraps.
- `Servers.DetailHeader` is **deleted**; `health`'s `ServerStatusHeader` becomes the identity
  section's `actions` (or its own `summary`), removing a single-contributor micro-slot that existed
  only because the form was hardcoded.
- The hardcoded form in `server-edit-form.tsx` becomes an `identity` section contributed by
  `servers` itself, carrying the name/host/user/port/console fields and the Delete button.

Net: three slots + a hardcoded block → one slot, four contributions.

### Phase 6 — the lint rule

New `plugins/primitives/plugins/detail-sections/lint/` following the `pane-toolbar` /
`data-view` layout (`index.ts` default-exporting `{ name, rules, ignores? }`; rule module via
`ESLintUtils.RuleCreator`; `RuleTester` test at module top level; registered repo-wide at `error`
by `build-lint-config.ts` after `./equin build` regenerates `lint.generated.ts`).

`no-adhoc-detail-sections` fires when **(a)** a JSX element's name is a member expression whose
immediate parent member is literally `Section` and which ends in `.Render`, **(b)** it has a
children render-prop, and **(c)** that callback's returned root JSX element is a bare `Surface`,
`Card`, or `SectionCard`. Verified against the five slots that must **not** trip it — `website.section`
and `home.section` pass no callback at all; `pages.welcome.section` and `profiling.section` return a
bare component / plain `div`; `ui/variant-region` uses `defineSlot`'s `.Region`, never `.Render`.
Multi-hop indirection (a callback returning a named helper that wraps the card two calls deeper) is
an accepted false negative — contributed rules run at `error`, so the repo's stated policy is to
favour false negatives.

## Open decision — the identity header

`chrome: "none"` above is what makes "a detail pane is one slot" literally true, and it is needed
either way: `task-detail` already contributes its header **as a section** (`task-header`, a bare
`Stack` with the title `<input>`), and under host-owned chrome that would otherwise become a
collapsible card titled "Header".

The alternative is to keep identity blocks as pane chrome above `<Host/>` — what `plugin-view`,
Studio, build, and deploy do today — and drop `chrome` from the contract entirely. That is a
smaller change but leaves every pane as *chrome + slot* rather than one slot, and would require
moving `task-header` out of the slot.

**Recommendation:** ship `chrome: "none"`, and use it for exactly three contributions —
`task-header`, `task-graph`, and deploy's `identity`. Panes that keep a hardcoded header above the
Host (plugin-view, Studio) can migrate opportunistically later; nothing forces them in this plan.

> **Correction (during implementation).** An earlier draft of this section also recommended
> `excludeFromReorder: true` on those contributions. That is WRONG and was not shipped:
> `excludeFromReorder` means *pinned last*, not *pinned in place* — `applyTree` appends excluded
> entries after everything else unconditionally (`reorder/web/internal/sorting.ts`, "Excluded items
> pinned last"). Setting it on `task-header` would sink the task's title/status block to the foot of
> the pane. First position comes from registration order instead. Pinning a section *first* needs a
> pin-first notion `reorder` does not have; that is a follow-up, not part of this change.

## Verification

1. `./equin build` — expect `reorderable-slots-in-sync`, `plugins-doc-in-sync` (every touched
   plugin), `plugins-registry-in-sync` (the new `lint/` dir), and `config:overrides-authored` (each
   new slot seeds a `// @review` override) to fail until regenerated files are committed. Then
   `./equin check` clean.
2. `bun test plugins/primitives/plugins/detail-sections/lint/` — rule fixtures.
3. `bun run test:dom plugins/primitives/plugins/detail-sections` — host behaviour: gate hook
   suppresses the whole card; collapsed body is unmounted; persisted open state round-trips.
4. Drive each migrated pane and confirm no double titles and no lost affordances:
   ```bash
   bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --url http://<worktree>.localhost:9000/deploy/server/<id> --click "Deployments" --out /tmp/deploy
   ```
   Repeat for `/tasks/<id>`, `/sonata/song/<id>`, `/pages/<id>`, `/workflows/<id>`,
   `/studio/comp/<id>`, and a plugin-view pane.
5. Reorder regression — the load-bearing one: with edit mode on (pen button), drag a section in
   Sonata and in Workflows, reload, confirm the order persisted **and** that pre-existing order was
   not reset by the id change (compare `config/<plugin>/<slotId>.jsonc` before/after).
6. Pane-gutter regression: open deploy → Deployments and task-detail → Dependencies (both embed a
   `DataView`) and confirm the rows align with the section's own inset — neither double-padded nor
   flush to the card edge.
