# Sink classification at the declaration site

## Context

`durable-signals-accounted` forces every durable sink (`defineLogSink` /
`defineFileSink`) to be a reviewed classification — but the classification
lives in a central `check/accounting.ts` (`Record<sinkId, { consumer, note,
reportKind?, timelineSource? }>`, 35 entries, 13 edits since August). Every new
sink in any feature plugin forces an edit to a framework-check file: the
"rule owner lists its consumers" shape that collection-consumer separation and
the inverted-exemptions design reject. Its stated justifications don't hold:

- *"Low-level primitives must never name reports/timeline"* — a closed
  `kind` enum plus opaque `reportKind` / `timelineSource` **strings** names
  nothing; the check (which already imports `TIMELINE_SOURCES` and scans
  `ReportKind(…)`) keeps validating them. No new import edge.
- *"Registry refactor disproportionate"* — no registry needed: a required field
  on the existing call.

Not an `exempt/` case: most entries are `internal`, a normal classification,
not a violation.

## Design

### Type (rung 2 — tsc forces the decision)

`plugins/infra/plugins/file-sink/core/internal/types.ts`:

```ts
/** Who reads a durable sink — a required, reviewed classification. */
export type SinkConsumer =
  | { kind: "report"; reportKind: string; timelineSource?: string; note: string }
  | { kind: "timeline"; timelineSource: string; note: string }
  | { kind: "rendering-only"; note: string }
  | { kind: "internal"; note: string };

export interface FileSinkSpec { id; description; path; maxBytes?; keep?;
  /** Who reads this file … (validated by durable-signals-accounted). */
  consumer: SinkConsumer; }
```

Exported from the `file-sink/core` barrel. `defineLogSink(spec: { id;
description; consumer: SinkConsumer })` imports the type and forwards
`consumer: spec.consumer` to its `defineFileSink`. Runtime ignores the field
(pure declaration); `FileSink` is unchanged.

`note` stays (what *reads* the sink — distinct from `description`, what is
*written*). Notes move verbatim from `accounting.ts` to each call site.

### Check (rung 3 — what types can't see)

`durable-signals-accounted` keeps: unresolvable-id failure, both-primitives
collision, computed-id exemptions. It drops: unclassified / stale-entry steps
(tsc + no list). Coherence now reads per call site:

- `scanSinkCalls` additionally reads the `consumer` field: its value must be an
  inline object literal (else **loud failure** unless the call site is exempt —
  so `consumer: SOME_VAR` cannot dodge validation). From it, `reportKind` and
  `timelineSource` are read with `parseStringField` (literal, or bare identifier
  resolved via the existing `resolveConst`; anything else is loud).
- `reportKind` must have a live `ReportKind({ kind })`; `timelineSource` must be
  in `TIMELINE_SOURCES` — same validation as today, now keyed by call site.
- The exempt `log-channels/server/internal/log.ts` (`id: spec.id`,
  `consumer: spec.consumer`) is skipped wholesale, as today.

Description / hints / plugin `CLAUDE.md` rewritten to point at the call site.

### Call sites

~35 non-test `defineLogSink` / `defineFileSink` calls gain
`consumer: { kind, …, note }` copied from their `accounting.ts` entry (incl.
`client-log` in `log-channels/.../client-ingress.ts`, `events-test-detached-sleep`).
Test calls (`file-sink.test.ts`, `read.test.ts`, `growth-bounds.test.ts`) get
`consumer: { kind: "internal", note: "test" }`.

Representative: `debug/boot-events/server/internal/write-boot-event.ts`,
`framework/cli/op-runtime/cli/build-progress.ts`,
`framework/tooling/checks/core/progress-log.ts`.

### Delete

`durable-signals-accounted/check/accounting.ts`.

### Docs

`durable-signals-accounted/CLAUDE.md`, `file-sink/CLAUDE.md`,
`log-channels/CLAUDE.md` — the classification is a required field on the
declaration; regenerated `docs/plugins-details.md` via build.

## Verification

- `./singularity check type-check` — every call compiles with a `consumer`.
- `./singularity check durable-signals-accounted` — passes; then manually
  break one (`reportKind: "nope"`, `consumer: X`) to confirm the loud failures.
- `./singularity test plugins/framework/plugins/tooling/plugins/checks/plugins/durable-signals-accounted plugins/infra/plugins/file-sink plugins/infra/plugins/retention`
  (scan.test.ts extended for consumer parsing).
- `./singularity build`.
