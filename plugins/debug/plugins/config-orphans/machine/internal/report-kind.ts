import { z } from "zod";
import { recordReport, ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { auditUserConfigOrphans } from "./orphan-audit";

export const STRANDED_CONFIG_KIND = "config-orphans-stranded";

/** How many config names the payload carries; `count` is the full total. */
const MAX_LISTED = 20;

const StrandedConfigPayloadSchema = z.object({
  count: z.number().int().positive(),
  /** `<hier>/<name>` of each stranded config, capped at MAX_LISTED. */
  storeKeys: z.array(z.string()),
});

type StrandedConfigPayload = z.infer<typeof StrandedConfigPayloadSchema>;

/**
 * The `config-orphans-stranded` report kind: **some of the user's saved
 * settings no longer apply.** A config override sits at a place no live config
 * reads — the plugin was removed, or it moved onto a destination that already
 * had settings (plugin moves otherwise carry saved settings along; see
 * relocate's apply-moves). The app silently runs the defaults instead.
 *
 * Only real user overrides count. Leftover generated snapshots (origins,
 * ancestors) hold no user data and never report.
 *
 * One row per namespace, forever: the fingerprint is constant, and each boot
 * refreshes the payload. A day's cooldown — this re-checks on every restart,
 * and a standing fact the user has seen should not ring on each one.
 */
export const strandedConfigKind = ReportKind({
  kind: STRANDED_CONFIG_KIND,
  schema: StrandedConfigPayloadSchema,
  fingerprint: () => STRANDED_CONFIG_KIND,
  meta: {
    tag: "[config]",
    notif: "Some saved settings no longer apply",
    variant: "warning",
    notifCooldownMs: 24 * 60 * 60 * 1000,
  },
  renderTask: (row: ReportRow) => {
    const d = StrandedConfigPayloadSchema.parse(row.data);
    return { title: strandedConfigTitle(d), description: describe(d) };
  },
});

function strandedConfigTitle(d: StrandedConfigPayload): string {
  return `[config] ${d.count} saved setting${d.count === 1 ? "" : "s"} no longer appl${d.count === 1 ? "ies" : "y"}`;
}

function describe(d: StrandedConfigPayload): string {
  return [
    `This namespace's user-layer config holds ` +
      `${d.count} config override(s) that no live config reads, so the app runs the defaults instead:`,
    "",
    ...d.storeKeys.map((k) => `- \`${k}\``),
    ...(d.count > d.storeKeys.length
      ? [`- … and ${d.count - d.storeKeys.length} more`]
      : []),
    "",
    "Open Debug → Config Orphans for the files, their sizes and where each config likely moved.",
    "For each one, decide with the user: carry the settings over to the config's new location, " +
      "or delete them if the config is gone for good. Never delete an override without asking — " +
      "the user layer is not versioned.",
  ].join("\n");
}

/** Audit this namespace's saved settings and file the report if any are stranded. */
export async function reportStrandedConfig(): Promise<void> {
  const stranded = (await auditUserConfigOrphans()).orphans.filter(
    (o) => o.riskClass === "stranded-data",
  );
  if (stranded.length === 0) return;
  const data: StrandedConfigPayload = {
    count: stranded.length,
    storeKeys: stranded.slice(0, MAX_LISTED).map((o) => o.storeKey),
  };
  await recordReport({
    kind: STRANDED_CONFIG_KIND,
    source: "server-config-audit",
    message: strandedConfigTitle(data),
    data,
  });
}
