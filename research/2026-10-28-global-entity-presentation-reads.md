# Entity presentation reads, declared once with the entity

## Context

An entity's web presentation (`FieldPresentation.Register({ owner: entityRef, reads })`)
lists the OTHER fields its cells read (the conversations status cell reads `id`, `title`,
`kind`, `createdAt`, `updatedAt`, `statusUnverifiedSince`). Every `liveCollection({ from:
entityRef })` had to `pick`/`carry` them by hand, and a miss was caught only at DataView
mount (`derived-fields.tsx`: "the presentation of entity X reads Y, which Z does not carry").
It shipped twice for `runtime-sdk.error-stopped` (59b05b7b35, cc16536253).

Goal (rung 1): the reads are declared once with the entity (core), and every collection
built on it carries them by construction — a collection has no way to miss one.

## Design

1. **`EntityRef` carries `presentationReads`** (`infra/entities/core/internal/entity-ref.ts`):
   `entityRef(name, fields, { presentationReads?: readonly (keyof F & string)[] })`, a third
   type parameter `R extends keyof F & string` (default `keyof F & string`, so every existing
   `EntityRef<string, infer F>` match still accepts a ref with reads). Runtime: each name must
   be a field of `fields` (throws otherwise); stored frozen, `[]` when absent.

2. **`liveCollection` auto-carries them** (`network/live/core/internal/live-fields.ts`):
   `resolveFieldsSpec` adds every `from.presentationReads` name not already picked/carried to
   the carried fields (before the `id` check). Types: `FieldsRow` / `RowFields` include
   `PresentationReadsOf<E>` beside `CP`, so the row type, `id`, `sortable` see them. Over an
   extension shape (`from` a shape) nothing changes. The server binds them like any carried
   base field (same-name column of the entity's table, `serve-collection.ts` `bindingOf`).

3. **The web registration loses `reads`** (`network/live/web/internal/field-presentation.ts`):
   an entity owner's cell row is `(K | PresentationReadsOf<O>) & keyof F` — derived from the
   ref, never restated. `StoredFieldPresentation.reads` and the merge in `derived-fields.tsx`
   go, and so does the mount-time assert (unreachable: a `from` collection carries them).

4. **Move the two existing declarations to their refs**:
   - `conversationsEntityRef` (`tasks/tasks-core/core/entity-refs.ts`) — the status cell's six.
   - `eventsEntityRef` (`apps/events/events-core/core/internal/entity-refs.ts`) — `allDay`.
   Drop the now-redundant hand carries made only for the presentation (error-stopped's
   `kind / createdAt / updatedAt / statusUnverifiedSince`).

5. **Docs / tests**: `network/live/CLAUDE.md` + data-view docs that describe `reads`;
   `derived-fields.test.ts` (the reads-mismatch tests become a `live-fields` test that the
   reads are carried); a `live-fields.test.ts` case for auto-carry and for an unknown read.

## Verification

- `./equin check type-check` (and full `./equin check`).
- `./equin test plugins/network/plugins/live plugins/primitives/plugins/data-view plugins/infra/plugins/entities`.
- `./equin build`, then open the Claude Code health row's stopped-conversations list and
  All-conversations / the events list on the worktree deploy — no mount throw.
