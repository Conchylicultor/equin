import { z } from "zod";
import { ReportKind, type ReportRow } from "@plugins/reports/server";

// The fork job's two reports. Both used to be bare bell notifications with
// nowhere to click. The job runs in a supervised child, so it files them through
// the report outbox and main's drain records them against these kinds.

const MESSAGE_MAX = 4_000;

export const DB_FORK_FAILED_KIND = "db-fork-failed";
export const FORK_UNDECLARED_SCHEMA_KIND = "fork-undeclared-schema";

const ForkFailedPayloadSchema = z.object({
  source: z.string(),
  target: z.string(),
  // A refusal from the fork PLAN (a declaration problem, deterministic — the
  // job does not retry it) versus a fork that threw while running (maybe
  // transient — the job retries). Different causes, different rows.
  planError: z.boolean(),
  error: z.string(),
});
type ForkFailedPayload = z.infer<typeof ForkFailedPayloadSchema>;

/**
 * The `db-fork-failed` report kind: **a worktree's database could not be forked
 * from main.** One row per (target, plan-or-run), so the job's retries collect
 * on it as its count.
 */
export const dbForkFailedKind = ReportKind({
  kind: DB_FORK_FAILED_KIND,
  schema: ForkFailedPayloadSchema,
  fingerprint: (d: ForkFailedPayload) =>
    `${DB_FORK_FAILED_KIND}:${d.target}:${d.planError ? "plan" : "run"}`,
  meta: {
    tag: "[db]",
    notif: "DB fork failed",
    variant: "error",
    category: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = ForkFailedPayloadSchema.parse(row.data);
    return {
      title: d.planError
        ? `[db] Fork plan refused for ${d.target}`
        : `[db] DB fork failed: ${d.source} → ${d.target}`,
      description: renderForkFailed(row, d),
    };
  },
});

function renderForkFailed(row: ReportRow, d: ForkFailedPayload): string {
  return [
    d.planError
      ? `The fork plan for \`${d.target}\` was refused. A plan refusal is ` +
        "deterministic — the same declarations fail identically every time — " +
        "so the job dead-lettered after one attempt. The fix is a fork " +
        "exclusion contribution, not a retry."
      : `Forking \`${d.source}\` into \`${d.target}\` threw. The job retries ` +
        "with backoff; each failure bumps this report's count.",
    "",
    "**Error:**",
    "",
    "```",
    clamp(d.error),
    "```",
    "",
    "The fork's full transcript is the `database-fork` log channel " +
      "(`logs/database-fork.jsonl` of the supervising backend).",
    "",
    `**Source:** \`${d.source}\``,
    `**Target:** \`${d.target}\``,
    `**Occurrences:** ${row.count}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  ].join("\n");
}

const UndeclaredSchemaPayloadSchema = z.object({
  schema: z.string(),
  // `describeUndeclaredSchema`'s one line: the schema and what is in it.
  description: z.string(),
  target: z.string(),
});
type UndeclaredSchemaPayload = z.infer<typeof UndeclaredSchemaPayloadSchema>;

/**
 * The `fork-undeclared-schema` report kind: **a schema no fork exclusion
 * covers was copied into a worktree fork.** Not a failure — the fork went
 * through — but main's rows for that schema now land in every fork, which a
 * human should decide about. Deduped per schema, so it is one row however many
 * worktrees fork.
 */
export const forkUndeclaredSchemaKind = ReportKind({
  kind: FORK_UNDECLARED_SCHEMA_KIND,
  schema: UndeclaredSchemaPayloadSchema,
  fingerprint: (d: UndeclaredSchemaPayload) =>
    `${FORK_UNDECLARED_SCHEMA_KIND}:${d.schema}`,
  meta: {
    tag: "[db]",
    notif: "Schema not covered by any fork exclusion",
    variant: "warning",
    category: "error",
    // A standing declaration gap that re-trips on every fork: re-arm about
    // daily rather than every time a worktree is created.
    notifCooldownMs: 24 * 60 * 60 * 1000,
  },
  renderTask: (row: ReportRow) => {
    const d = UndeclaredSchemaPayloadSchema.parse(row.data);
    return {
      title: `[db] Schema \`${d.schema}\` is not covered by any fork exclusion`,
      description: [
        `${d.description}.`,
        "",
        "No plugin declared how this schema's data should be forked, so " +
          "main's rows for it are copied into every worktree database. Find " +
          "the plugin that owns the schema and declare it with " +
          "`ExcludeSchemaDataFromFork` (`database/admin`), or decide it should " +
          "be copied and say so there.",
        "",
        `**Schema:** \`${d.schema}\``,
        `**Latest fork:** \`${d.target}\``,
        `**Occurrences:** ${row.count}`,
        `**First seen:** ${row.firstSeenAt.toISOString()}`,
        `**Last seen:** ${row.lastSeenAt.toISOString()}`,
      ].join("\n"),
    };
  },
});

function clamp(value: string): string {
  return value.length <= MESSAGE_MAX
    ? value
    : `${value.slice(0, MESSAGE_MAX)}\n… [truncated ${value.length - MESSAGE_MAX} chars]`;
}
