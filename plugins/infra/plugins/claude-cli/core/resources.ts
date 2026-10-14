import { z } from "zod";
import {
  liveCollection,
  liveValue,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import {
  FALLBACK_MODEL,
  StoredModelSchema,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import { uuidField } from "@plugins/fields/plugins/uuid/plugins/config/core";
import {
  enumTextField,
  textField,
  parsedTextField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";

// One recorded `claude --print` call. The physical `claude_cli_calls` table
// (server/internal/tables.ts) and the public `ClaudeCliCall` wire schema below
// both derive from this single field record, so a column ↔ schema drift is
// unrepresentable. Keyed by JS prop name IN COLUMN ORDER.
//
// `model` is a plain `text` column in the DDL, decoded by the tolerant
// `StoredModelSchema` — so the `ConversationModel` in its type is what really
// runs on every read and write, and a malformed stored id normalizes (and is
// reported) instead of being handed to typed code as if it were a live model. That is the same guard the wire schema
// used to carry alone, now one layer lower, where the server-side readers are.
//
// The baseline's default version (`FALLBACK_MODEL`) is the wire/backfill default, where the tuple form silently
// gave `"fable-5-1"` — the first entry of the enum, i.e. tuple order rather than
// anyone's decision. Nothing observable changes: the column is notNull with no
// DB default, so every row carries a model and the wire schema's `.default()`
// never fires.
export const claudeCliCallFields = {
  id: uuidField(),
  createdAt: dateField(),
  model: parsedTextField(StoredModelSchema, {
    default: FALLBACK_MODEL,
  }),
  sourceName: textField(),
  sourceContext: nullable(
    jsonField<Record<string, unknown>>({
      schema: z.record(z.unknown()),
      default: {},
    }),
  ),
  prompt: textField(),
  system: nullable(textField()),
  output: nullable(textField()),
  error: nullable(textField()),
  durationMs: intField(),
  // The domain record this call was made FOR — a run id, a task id, whatever row
  // the caller is explaining. Free-form and NOT namespaced by `sourceName`, so it
  // must be a globally unique row id (a UUID); a per-caller counter would collide
  // across callers and hand one plugin another's calls. Appended last so the
  // record still reads in physical column order.
  correlationId: nullable(textField()),
} satisfies FieldsRecord;

// No `model` re-widening: the field's own schema IS `StoredModelSchema` now, so
// `fieldsToZodObject` already derives the tolerant arm — a malformed stored
// model normalizes to a concrete one instead of rejecting the row and blanking
// the whole calls array on the WS push path. Overriding it here would restate
// the same schema in a second place, which is the drift this derivation exists
// to remove.
export const ClaudeCliCallSchema = fieldsToZodObject(claudeCliCallFields);
export type ClaudeCliCall = z.infer<typeof ClaudeCliCallSchema>;

/**
 * How many calls the log keeps: the recorder trims `claude_cli_calls` to the
 * newest this-many rows after every insert (`record-call.ts`), and a window of
 * the `claudeCliCalls` collection grows to at most the same — so a fully grown
 * window is the whole log.
 */
export const RECENT_CALLS_LIMIT = 1000;

/**
 * Whether a call succeeded: `"error"` exactly when it recorded an `error`. Not a
 * stored column — the served collection computes it in SQL (`error IS NOT
 * NULL`), so it filters, groups and counts on the server like any column while
 * no write can ever make it disagree with `error`.
 */
export const CLAUDE_CLI_CALL_STATUSES = ["ok", "error"] as const;
export const ClaudeCliCallStatusSchema = z.enum(CLAUDE_CLI_CALL_STATUSES);
export type ClaudeCliCallStatus = z.infer<typeof ClaudeCliCallStatusSchema>;

/**
 * The call log — Debug → Claude CLI Calls — as a live collection: a bounded
 * window, newest first (100, grown to at most `RECENT_CALLS_LIMIT`), plus its
 * `:rows` / `:groups` siblings. It backs the pane's live DataView (key-range
 * pages): search runs over the prompt / output / error text, the Source and
 * Model filters are `:groups` facets of the whole log (not the loaded window),
 * and `status` (derived from `error`) filters and groups like a column. Since
 * the recorder trims the log to `RECENT_CALLS_LIMIT` rows, every query here is
 * over at most that many — the full-text `contains` over the prompt is a scan of
 * a table that cannot grow past it.
 *
 * Its fields are the log's physical columns ({@link claudeCliCallFields}) as a
 * list shows them, plus the derived `status`; the ones no list shows ride on
 * the row (`carry`).
 */
export const claudeCliCalls = liveCollection("claude-cli-calls", {
  fields: {
    status: enumTextField(CLAUDE_CLI_CALL_STATUSES, {
      label: "Status",
      options: {
        ok: { label: "Succeeded", variant: "success" },
        error: { label: "Failed", variant: "destructive" },
      },
    }),
    createdAt: dateField({ label: "Time" }),
    sourceName: textField({ label: "Source" }),
    model: parsedTextField(StoredModelSchema, {
      label: "Model",
      default: FALLBACK_MODEL,
    }),
    durationMs: intField({ label: "Duration" }),
    // Filter-only text columns ("Prompt contains …", "Error is not empty").
    prompt: textField({ label: "Prompt" }),
    output: nullable(textField({ label: "Output" })),
    error: nullable(textField({ label: "Error" })),
  },
  carry: {
    fields: {
      id: claudeCliCallFields.id,
      system: claudeCliCallFields.system,
      sourceContext: claudeCliCallFields.sourceContext,
      correlationId: claudeCliCallFields.correlationId,
    },
  },
  id: "id",
  sortable: ["createdAt", "durationMs", "sourceName", "model"],
  default: { orderBy: [["createdAt", "desc"]], limit: 100 },
  maxLimit: RECENT_CALLS_LIMIT,
});

/** A row of the {@link claudeCliCalls} collection: the call, plus its derived `status`. */
export type ClaudeCliCallRow =
  typeof claudeCliCalls extends LiveRowsCollection<infer R> ? R : never;

/**
 * The answer to "which model calls produced this record?" — a discriminated
 * result, never a bare array, because an empty array would collapse three
 * genuinely different answers a consumer must render differently:
 *
 * - `calls`        — here they are.
 * - `none`         — this record never made a model call. For a cheap cache-hit
 *                    run that deliberately skipped the expensive phase, this is
 *                    the CORRECT and expected outcome, not a gap.
 * - `not-retained` — it did make one, but the call log is a global ring of the
 *                    most recent N calls and has since trimmed it. The text is
 *                    gone; saying so is the honest answer.
 *
 * `[]` for all three would render "no model call" over a run whose prompt merely
 * aged out — a wrong explanation, silently. That is exactly what the repo's
 * `no-absorbed-failure` rule exists to prevent (same shape as
 * `RefreshSourceResultSchema` in `events-core`).
 */
export const ClaudeCliCallsResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("calls"), calls: z.array(ClaudeCliCallSchema) }),
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("not-retained") }),
]);
export type ClaudeCliCallsResult = z.infer<typeof ClaudeCliCallsResultSchema>;

/**
 * The calls recorded for one domain record, oldest first, as a live value —
 * served `db` over `claude_cli_calls`, so a call recorded (or trimmed) while a
 * reader watches is pushed to it.
 *
 * `occurredAt` is when the asking record happened (a run's `startedAt`, a
 * task's creation), as an ISO instant. It is what makes `not-retained`
 * distinguishable from `none`: without it the reader cannot tell "never
 * called" from "called before the retention horizon", so an omitted
 * `occurredAt` always reports `none`. A present `occurredAt` that is not an
 * instant is refused `invalid-occurred-at` — a malformed question, not a server
 * failure. (It cannot be a typed param: every typed param is required.)
 */
export const claudeCliCallsFor = liveValue("claude-cli.calls-for", {
  schema: ClaudeCliCallsResultSchema,
  params: ["correlationId", "occurredAt?"],
  refusals: ["invalid-occurred-at"],
});
