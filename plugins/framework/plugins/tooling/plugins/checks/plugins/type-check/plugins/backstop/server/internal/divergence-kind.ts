import { z } from "zod";
import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";

/** The kind string, named once and imported by whoever files one. */
export const TYPE_CHECK_DIVERGENCE_KIND = "type-check-divergence";

export const TypeCheckDivergencePayloadSchema = z.object({
  /** The repo-relative file whose keyed result differed. */
  file: z.string(),
  /** What differed: its diagnostics, its signature, or whether it was checked at all. */
  kind: z.enum(["diagnostics", "signature", "missing"]),
  /** The keyed check's side, and the full check's. */
  keyed: z.string(),
  full: z.string(),
  /** The main commit the backstop checked. */
  head: z.string(),
});

export type TypeCheckDivergencePayload = z.infer<
  typeof TypeCheckDivergencePayloadSchema
>;

/**
 * The `type-check-divergence` report kind: **the keyed type check reused a
 * result that a full check disagrees with** — a stale verdict, the one failure
 * the keyed check must never have (type-check's `shared/keyed-check.ts`). It
 * means a file's key missed something its check reads: the key must be
 * widened, not the entry deleted (the backstop has already overwritten it).
 *
 * One row per (file, kind), so a divergence that persists day after day is one
 * row whose count grows. Variant `error`: a green check may have shipped a
 * type error.
 */
export const typeCheckDivergenceKind = ReportKind({
  kind: TYPE_CHECK_DIVERGENCE_KIND,
  schema: TypeCheckDivergencePayloadSchema,
  fingerprint: (d: TypeCheckDivergencePayload) =>
    `${TYPE_CHECK_DIVERGENCE_KIND}:${d.kind}:${d.file}`,
  meta: {
    tag: "[type-check]",
    notif: "The keyed type check diverged from a full check",
    variant: "error",
    notifCooldownMs: 24 * 60 * 60 * 1000,
  },
  renderTask: (row: ReportRow) => {
    const d = TypeCheckDivergencePayloadSchema.parse(row.data);
    return {
      title: `[type-check] Keyed check diverged on ${d.file} (${d.kind})`,
      description: [
        `The daily type-check backstop ran the keyed check beside a full check of a fresh program on main (${d.head}), and they disagree about \`${d.file}\`'s ${d.kind}.`,
        "",
        "The keyed check reuses a file's stored diagnostics and signature while its key — its text plus its type fingerprint, the declarations it can see — is unchanged (`plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/keyed-check.ts`). A divergence means the check read something the key does not cover. Find what, and widen the key: the store entry was already overwritten by the full check's answer, so deleting it fixes nothing.",
        "",
        "Reproduce with `./singularity run plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/scripts/dual-check.ts <checkout>` on the tree before, then after, the commit that made the file diverge.",
        "",
        `**Keyed:**\n\`\`\`\n${d.keyed}\n\`\`\``,
        `**Full:**\n\`\`\`\n${d.full}\n\`\`\``,
        "",
        `**Occurrences:** ${row.count} (first ${row.firstSeenAt.toISOString()}, last ${row.lastSeenAt.toISOString()})`,
      ].join("\n"),
    };
  },
});
