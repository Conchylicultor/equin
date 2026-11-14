import { z } from "zod";
import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";

/**
 * One thing this run did not deliver.
 *
 * `kind` is WHERE it came up short, and there are three because a backup can
 * fall over in three genuinely different places — not as a taxonomy for its own
 * sake. A source that threw leaves a gap INSIDE an archive that exists; a
 * target that refused means the archive exists and went nowhere; and a run that
 * died in assembly, or was killed before recording anything, produced no
 * archive at all. Collapsing those under one heading would make the report say
 * the archive is missing a piece when in fact there is no archive.
 */
const BackupGapSchema = z.object({
  kind: z.enum(["source", "target", "run"]),
  /** The component's human name (`Databases`, `google-drive`, `Assembly`). */
  what: z.string(),
  /** That component's own words, unedited. */
  error: z.string(),
});

export type BackupGap = z.infer<typeof BackupGapSchema>;

export const BackupIncompletePayloadSchema = z.object({
  runId: z.string(),
  status: z.enum(["partial", "failed"]),
  trigger: z.enum(["manual", "periodic"]),
  gaps: z.array(BackupGapSchema),
});

export type BackupIncompletePayload = z.infer<
  typeof BackupIncompletePayloadSchema
>;

const GAP_HEADING: Record<BackupGap["kind"], string> = {
  source: "Sources that did not assemble",
  target: "Targets the archive did not reach",
  run: "Why the run produced no archive",
};

/**
 * The `backup-incomplete` report kind: **the nightly backup did not fully
 * succeed.**
 *
 * This kind exists because of a three-night outage that alerted NOWHERE. The
 * backup ledger recorded `failed` each night and the run card said so, but
 * nothing pushed it: the bell stayed quiet, Reports held no row for it, and the
 * only way to learn that the machine had gone three days without an archive —
 * and six without an off-site copy — was to open the backup pane and look.
 * Under the front-door invariant that is the bug behind the bug, so the signal
 * now lands in the funnel everything else lands in.
 *
 * Variant `error`, with no warning arm for `partial`. A backup is the artifact
 * you only reach for when everything else is gone, so "we archived most of it"
 * and "we archived it but it never left the machine" are both the failure this
 * is for. Grading them would mean the quieter one is the one that goes unread.
 *
 * Deduped on WHAT is missing, not on the run: the same gap recurring every
 * night is one problem and collapses onto one row with a rising count, while a
 * new source starting to fail mints its own. The cooldown re-arms the bell
 * daily-ish, so a standing gap resurfaces instead of being marked read once and
 * never seen again.
 *
 * `duressExempt`, for the reason the queue-health kinds are: a backup is most
 * likely to fail on a night the box is in trouble, which is exactly the night
 * the shed engine would buffer this away.
 */
export const backupIncompleteKind = ReportKind({
  kind: "backup-incomplete",
  schema: BackupIncompletePayloadSchema,
  fingerprint: (d: BackupIncompletePayload) => {
    const gaps = d.gaps.map((g) => `${g.kind}:${g.what}`).sort();
    return `backup-incomplete:${d.status}:${gaps.join(",")}`;
  },
  duressExempt: true,
  meta: {
    tag: "[backup]",
    notif: "Backup did not fully succeed",
    variant: "error",
    category: "error",
    // Six hours. The schedule is nightly, so this re-arms the bell about once
    // per run rather than once per occurrence — enough that a standing gap
    // comes back, rare enough that it is never noise.
    notifCooldownMs: 6 * 60 * 60 * 1000,
  },
  renderTask: (row: ReportRow) => {
    const d = BackupIncompletePayloadSchema.parse(row.data);
    return { title: title(d), description: render(row, d) };
  },
});

/** The one-line summary, also used as the report's `message`. */
export function backupGapSummary(d: {
  status: "partial" | "failed";
  gaps: readonly BackupGap[];
}): string {
  const what = d.gaps.map((g) => g.what).join(", ");
  return `[backup] run ${d.status}${what.length > 0 ? `: ${what}` : ""}`;
}

function title(d: BackupIncompletePayload): string {
  const what = d.gaps.map((g) => g.what).join(", ");
  const named = what.length > 0 ? what : "unknown";
  return d.status === "failed"
    ? `[backup] backup failed — no archive reached storage (${named})`
    : `[backup] backup incomplete — ${named}`;
}

function render(row: ReportRow, d: BackupIncompletePayload): string {
  const noArchive = d.gaps.some((g) => g.kind === "run");
  const lines: string[] = [];
  lines.push(
    noArchive
      ? "**This run produced no archive at all.** It did not get as far as a " +
          "file, so the newest usable backup is whatever the last successful " +
          "run left behind."
      : d.status === "failed"
        ? "**This machine has no new backup.** An archive was built but " +
          "reached no storage target, so the newest usable backup is " +
          "whatever the last successful run left behind."
        : "**The backup ran but is not whole.** An archive was written and " +
          "reached at least one target, and what is listed below is missing " +
          "from it — so a restore from this archive comes back short.",
  );
  lines.push("");
  for (const kind of ["run", "source", "target"] as const) {
    const group = d.gaps.filter((g) => g.kind === kind);
    if (group.length === 0) continue;
    lines.push(`**${GAP_HEADING[kind]}**`);
    lines.push("");
    for (const g of group) lines.push(`- \`${g.what}\` — ${g.error}`);
    lines.push("");
  }
  lines.push(
    "**What to do:** open the run in **Debug → Backup** for the full " +
      "manifest — it lists every source and, for a partial one, what it did " +
      "get through. A target refused for a lapsed OAuth token carries a " +
      "**Grant access** button on that pane, which is the whole repair.",
  );
  lines.push("");
  if (!noArchive) {
    lines.push(
      "A source failing does not stop the others: each is assembled on its " +
        "own and a thrower is recorded and stepped over. So this report names " +
        "a gap in an archive that otherwise exists.",
    );
    lines.push("");
  }
  lines.push(`**Run:** \`${d.runId}\` (${d.trigger})`);
  lines.push(`**Status:** \`${d.status}\``);
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
