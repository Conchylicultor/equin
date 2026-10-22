import { z } from "zod";
import { SPAN_KINDS, type FlightWindow } from "@plugins/infra/plugins/runtime-profiler/core";

// The ONE zod mirror of the profiler's FlightWindow, shared by this plugin's two
// runtimes: the server registers it as the spans class's section `schema`, the web
// parses the (opaque) `snapshot.events.spans` back out with it. `runtime-profiler/core`
// is zero-dependency by contract, so the mirror cannot live there; `shared/` is
// plugin-private DRY between our own web and server — exactly its purpose.
// (Precedent: `debug/profiling/plugins/runtime/core/endpoints.ts`.)
//
// Derived from SPAN_KINDS, NEVER hand-written. The two hand-mirrors this file
// replaces both hardcoded a 7-kind enum and omitted `cascade`, so any cascade span
// in a captured window failed `safeParse` and the engine dropped the *entire* spans
// section from the trace.
const spanKindSchema = z.enum(SPAN_KINDS);

export const FlightSpanSchema = z.object({
  // Per-instance identity minted by the recorder. `parentId` names the enclosing
  // entry INSTANCE (not a `{kind,label}` snapshot), which is what makes the
  // client-side tree exact for concurrent same-label spans.
  id: z.number(),
  parentId: z.number().nullable(),
  kind: spanKindSchema,
  label: z.string(),
  t0: z.number(),
  t1: z.number().nullable(), // null => still open at capture
  ageMs: z.number(),
  waitMs: z.number(),
  childMs: z.number(),
  selfMs: z.number(),
  waits: z.record(z.number()).optional(),
  // Positioned wait intervals per layer. OPTIONAL so every pre-band `traces` row
  // still parses as `ok` (not `legacy`, not `invalid`); the bidirectional pin
  // below forces this and the recorder's `FlightSpan.waitBands` to move together.
  waitBands: z
    .array(z.object({ layer: z.string(), t0: z.number(), t1: z.number() }))
    .optional(),
});

export const FlightWindowSchema = z.object({
  atMs: z.number(),
  open: z.array(FlightSpanSchema),
  completed: z.array(FlightSpanSchema),
});

// BIDIRECTIONAL compile-time pin. The one-way assertion these files used to carry
// (`const _a: FlightWindow = {} as z.infer<Schema>`) is precisely what let `cascade`
// drift through: a schema whose `kind` union is NARROWER than SpanKind is still
// assignable to FlightWindow. Only the reverse direction catches a *missing* member;
// only the forward direction catches an *extra* one. Both, or neither works.
const _schemaAssignableToSource: FlightWindow = {} as z.infer<typeof FlightWindowSchema>;
const _sourceAssignableToSchema: z.infer<typeof FlightWindowSchema> = {} as FlightWindow;
void _schemaAssignableToSource;
void _sourceAssignableToSchema;

/**
 * The result of reading `snapshot.events.spans`. A discriminated union, never
 * `null`: "no spans section", "a pre-id payload", and "a corrupt payload" are three
 * different facts a reader must be able to tell apart (repo rule — failure is a
 * type, not an absorbable value). The old `FlightWindow | null` conflated all three
 * into a misleading "no spans in flight".
 */
export type SpansSection =
  | { kind: "ok"; window: FlightWindow }
  | { kind: "absent" }
  /** Captured before per-instance ids existed: spans carry a `parents` label chain. */
  | { kind: "legacy" }
  | { kind: "invalid"; message: string };

// Structural probe used only to separate "legacy" from genuine corruption: a flight
// window whose spans are objects, without asserting anything about their fields.
const legacyProbeSchema = z.object({
  atMs: z.number(),
  open: z.array(z.record(z.unknown())),
  completed: z.array(z.record(z.unknown())),
});

/** Parse the opaque `snapshot.events.spans` section into an explicit outcome. */
export function parseSpansSection(payload: unknown): SpansSection {
  if (payload === undefined || payload === null) return { kind: "absent" };

  const parsed = FlightWindowSchema.safeParse(payload);
  if (parsed.success) return { kind: "ok", window: parsed.data };

  // A pre-id payload is shaped like a flight window, but *every* span lacks `id`
  // (they carried a `parents` label chain instead). A payload where only some spans
  // lack it is corruption, not a version skew — fall through to "invalid".
  const probe = legacyProbeSchema.safeParse(payload);
  if (probe.success) {
    const spans = [...probe.data.open, ...probe.data.completed];
    if (spans.length > 0 && spans.every((s) => s["id"] === undefined)) return { kind: "legacy" };
  }

  const issue = parsed.error.issues[0];
  const at = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return { kind: "invalid", message: issue ? `${at}${issue.message}` : "malformed spans section" };
}
