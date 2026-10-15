# Remove the durable-sink consumer classification

**Supersedes:** [`2026-10-14-global-sink-classification-at-declaration.md`](./2026-10-14-global-sink-classification-at-declaration.md)
(and the classification half of the `durable-signals-accounted` design).

## Context

Every `defineLogSink` / `defineFileSink` call must carry a required
`consumer: SinkConsumer` (`report | timeline | rendering-only | internal` +
`note`), and the `durable-signals-accounted` check validates it. It was added
after the 2026-07-17 incident: a never-ready boot of main sat in `boot.jsonl`
and reached no alert.

It's the wrong mechanism, for these reasons:

- **The direction is backwards.** The code that sets something up knows when
  it has failed, so that code detects the failure and raises the alert. The
  alert may *point to* a log as evidence. A log never needs to know that an
  alert exists. The incident was fixed by `debug/boot-watchdog`, a job that
  files `boot-wedge`. That fix works whatever tag the `boot` channel carries.
- **Nothing reads the field at runtime.** `defineFileSink` drops it, and so
  does `makeSink`. It is pure annotation.
- **The check checks names, not wiring.** `reportKind: "boot-wedge"` only has
  to name a live `ReportKind`. Nothing checks that the sink feeds that report.
- **It doesn't catch the failure it was built for.** An agent adding a new
  failure signal tags it `internal` and moves on. 28 of the ~50 sinks already
  are.

**What stays:** the bounded-append primitive (`infra/file-sink`) with its
rotation, `defineLogSink` as the only way to get a persisted channel, the
`description` field, `getFileSinks()`, the growth-bound merge, and the
`sink-safety` lint rules. Only the classification is removed.

## Changes

### 1. Primitive types: delete `SinkConsumer`

- `plugins/infra/plugins/file-sink/core/internal/types.ts`: delete the
  `SinkConsumer` type and the `consumer` field of `FileSinkSpec`.
- `plugins/infra/plugins/file-sink/core/index.ts`: drop the `SinkConsumer`
  re-export.
- `plugins/primitives/plugins/log-channels/server/internal/log.ts`: drop
  `consumer` from `defineLogSink`'s spec, its import, and the forwarding into
  `defineFileSink`.

### 2. Call sites: drop the `consumer: { … }` property

About 40 sites across 36 files apply one mechanical pattern: delete the whole
`consumer: { kind, …, note }` property. If a `note` carries real information
that the `description` lacks (most of it is "what reads this"), fold one
clause into `description`. Otherwise drop it. Examples:

- `debug/boot-events/server/internal/write-boot-event.ts`
- `debug/sentinel/server/internal/worker/entry.ts`
- `framework/cli/plugins/op-runtime/cli/build-progress.ts`
- `framework/tooling/checks/core/progress-log.ts`
- `primitives/log-channels/server/internal/client-ingress.ts`

Tests: `file-sink/core/internal/file-sink.test.ts` (`TEST_CONSUMER` and its
uses), plus any other test that passes `consumer` (tsc flags them all).

### 3. Delete the check

- Delete
  `plugins/framework/plugins/tooling/plugins/checks/plugins/durable-signals-accounted/`
  entirely: `check/index.ts`, `scan.ts`, `scan.test.ts`, `CLAUDE.md`,
  `package.json`.
- Its non-classification guards don't need a replacement:
  - **Duplicate ids** already throw at runtime in `defineFileSink` and in the
    log-channel registry.
  - **Cross-primitive id collision** isn't a real hazard. A log sink's file is
    `<logsDir>/<id>.jsonl`, while a bare file sink has a caller-owned path, so
    the two never write the same file.
  - **Unresolvable / computed ids** existed only to feed the classification.
- `plugins/primitives/plugins/log-channels/exempt/index.ts`: its only entry is
  the `durable-signals-accounted` exemption, so delete the file.
- Generated files are refreshed by `./singularity build`:
  `checks/core/check.generated.ts`, `exempt/core/rule-ids.generated.ts`,
  `bun.lock` (the workspace package is gone), and `docs/plugins-*.md`.

### 4. Docs

Remove the classification and check references from:

- `infra/file-sink/CLAUDE.md`
- `primitives/log-channels/CLAUDE.md`
- `framework/tooling/checks/CLAUDE.md` (the check's list entry)
- `debug/boot-watchdog/CLAUDE.md` ("enforces that the `boot` channel stays
  classified…"): replace with a sentence saying that the watchdog itself is
  what turns a never-ready boot into a report.
- `debug/sentinel/CLAUDE.md` ("…wiring is enforced by the
  `durable-signals-accounted` check"): drop that sentence.

Add one line to `infra/file-sink/CLAUDE.md`, the principle that replaces the
check: *a sink is evidence, not a signal. Failure detection and alerting
belong to the code that owns the operation (it files a `ReportKind`). A report
may point to a log, and a log never declares its readers.*

Research docs stay as history, apart from the *Supersedes* link above.

## Out of scope

- Building the undeclared-growth monitor, or removing `getGrowthBounds()`'s
  file merge, which still has no non-test reader.
- Moving read-back "store" sinks (op-log, health samples) to tables.

## Verification

- `./singularity check type-check`: zero errors means no call site or test
  still passes `consumer`.
- `rg -n "SinkConsumer|durable-signals-accounted|consumer: \{ kind"
  -g '!research/**'` returns nothing.
- `./singularity test plugins/infra/plugins/file-sink plugins/infra/plugins/retention plugins/primitives/plugins/log-channels`
- `./singularity build`: regenerates the registries and docs, and runs the
  full check suite, including `plugins-registry-in-sync`, the exemptions'
  unused-exemption verdict, and `plugins-doc-in-sync`.
- Smoke test: after the build, `~/.singularity/worktrees/<wt>/logs/boot.jsonl`
  still gets its start and ready lines (the write path is unchanged).
