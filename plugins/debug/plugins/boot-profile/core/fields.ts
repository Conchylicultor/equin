import { z } from "zod";
import {
  fieldsToZodObject,
  type FieldsRecord,
} from "@plugins/fields/core";
import { uuidField } from "@plugins/fields/plugins/uuid/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import type { BootTrace } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";

// Explicit zod mirror of the cross-runtime `BootTrace` shape (boot-trace/core).
// A persisted snapshot is app-written, never hand-edited, but a malformed POST
// body must still fail loudly — so the wire boundary validates against this
// schema rather than trusting the blob. The compile-time assertion below pins it
// to the source type, so the two can never silently drift.
const BootSpanSchema = z.object({
  id: z.string(),
  phase: z.enum([
    "navigation",
    "scripts",
    "main-thread",
    "boot-tasks",
    "resources",
    "assets",
    "paint",
  ]),
  label: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
  workMs: z.number().optional(),
  detail: z.string().optional(),
});

const NavTimingSchema = z.object({
  fetchStartMs: z.number(),
  domainLookupStartMs: z.number(),
  domainLookupEndMs: z.number(),
  connectStartMs: z.number(),
  connectEndMs: z.number(),
  requestStartMs: z.number(),
  responseStartMs: z.number(),
  responseEndMs: z.number(),
  domInteractiveMs: z.number(),
  domContentLoadedEndMs: z.number(),
});

const LongTaskSchema = z.object({
  startMs: z.number(),
  durationMs: z.number(),
  name: z.string(),
});

const AssetTimingSchema = z.object({
  name: z.string(),
  initiatorType: z.string(),
  startMs: z.number(),
  responseStartMs: z.number(),
  responseEndMs: z.number(),
  transferSize: z.number(),
  decodedBodySize: z.number(),
});

export const BootTraceSchema = z.object({
  spans: z.array(BootSpanSchema),
  navigation: NavTimingSchema.nullable(),
  paint: z.object({
    firstPaintMs: z.number().nullable(),
    firstContentfulPaintMs: z.number().nullable(),
  }),
  firstCommitMs: z.number().nullable(),
  longTasks: z.array(LongTaskSchema),
  assets: z.array(AssetTimingSchema),
  capturedAt: z.number(),
});

// Compile-time guard: the explicit wire schema must stay assignable to the
// canonical `BootTrace`. If the source type changes (a field added/renamed) and
// `BootTraceSchema` isn't updated to match, this assignment fails `tsc`.
const _assertBootTrace: BootTrace = {} as z.infer<typeof BootTraceSchema>;
void _assertBootTrace;

// One persisted boot-trace snapshot: the durable analogue of the in-memory
// `getBootTrace()` capture, written only on an explicit "Copy permalink" click.
// The table + the `SavedBootTrace` wire schema both derive from this single
// record (server/internal/tables.ts), so a column/schema drift is unrepresentable.
// The labels are the Boot Profiles browse pane's columns: the `bootTraces`
// collection picks them.
export const savedBootTraceFields = {
  id: uuidField({ label: "Id", filterable: false }),
  worktree: textField({ label: "Worktree", primary: true }),
  snapshot: jsonField<BootTrace>({
    schema: BootTraceSchema,
    default: {} as BootTrace,
  }),
  createdAt: dateField({ label: "When" }),
} satisfies FieldsRecord;

/** The `boot_traces` entity: the table is built from these fields (`server/internal/tables.ts`). */
export const bootTracesEntityRef = entityRef(
  "boot_traces",
  savedBootTraceFields,
);

export const SavedBootTraceSchema = fieldsToZodObject(savedBootTraceFields);
export type SavedBootTrace = z.infer<typeof SavedBootTraceSchema>;
