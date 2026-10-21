import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  TYPE_CHECK_DIVERGENCE_KIND,
  TypeCheckDivergencePayloadSchema,
  type TypeCheckDivergencePayload,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/core";

const NAME_RUN =
  "`plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/name-run.ts`";

/**
 * The `type-check-divergence` report kind: **the two-program type check
 * reported, or nearly reported, a result that a full check disagrees with** —
 * a stale verdict, the one failure it must never have (type-check's
 * `shared/name-run.ts`). Filed by the daily backstop (a file whose result
 * differed from a full check's), and by any check run whose program 2 found a
 * name moved that the affected set predicted stable (`prediction`: that run
 * fell back to one whole program, so its verdict was right). Either way a
 * file's key, or the affected set, missed something a check reads: they must
 * be widened, not the entry deleted (the store was already rewritten).
 *
 * One row per (file, kind), so a divergence that persists day after day is one
 * row whose count grows. Variant `error`: a green check may have shipped a
 * type error.
 */
export const typeCheckDivergenceKind = ReportKind({
  kind: TYPE_CHECK_DIVERGENCE_KIND,
  schema: TypeCheckDivergencePayloadSchema,
  fingerprint: (d: TypeCheckDivergencePayload) =>
    d.kind === "prediction"
      ? `${TYPE_CHECK_DIVERGENCE_KIND}:prediction:${d.file}#${d.name}`
      : `${TYPE_CHECK_DIVERGENCE_KIND}:${d.kind}:${d.file}`,
  meta: {
    tag: "[type-check]",
    notif:
      "The two-program type check diverged, or nearly did, from a full check",
    variant: "error",
    notifCooldownMs: 24 * 60 * 60 * 1000,
  },
  renderTask: (row: ReportRow) => {
    const d = TypeCheckDivergencePayloadSchema.parse(row.data);
    const occurrences = `**Occurrences:** ${row.count} (first ${row.firstSeenAt.toISOString()}, last ${row.lastSeenAt.toISOString()})`;
    if (d.kind === "prediction") {
      return {
        title: `[type-check] Affected set missed ${d.file}#${d.name}`,
        description: [
          `A type-check run (at ${d.head}) re-checked \`${d.file}\` in program 2 and found its export \`${d.name}\` moved, though the affected set had predicted it stable — so the files using it were not going to be re-checked. The run noticed, re-checked every file in one program and rewrote the store, so its verdict was right; it cost a cold check.`,
          "",
          `The prediction (\`phase1\` / \`predictBottom\` in \`shared/name-walk.ts\`, run by ${NAME_RUN}) marks a re-checked file's name ⊥ when an edge of its previous result (name-use or inference) reaches a target whose meaning moved. A miss means some influence on that name's \`.d.ts\` text has no edge, or a meaning comparison is wrong. Find which, and widen it.`,
          "",
          "Reproduce with `./singularity run plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/scripts/dual-check.ts <checkout> --mode keyed` on the tree before, then after, the change (keyed mode throws on a miss).",
          "",
          occurrences,
        ].join("\n"),
      };
    }
    return {
      title: `[type-check] Keyed check diverged on ${d.file} (${d.kind})`,
      description: [
        `The daily type-check backstop ran the keyed check beside a full check of a fresh program on main (${d.head}), and they disagree about \`${d.file}\`'s ${d.kind}.`,
        "",
        `The two-program check reuses a file's stored diagnostics while its result key — its text, the meanings of the names it uses, the global scope — is unchanged, and re-checks the files its affected set predicts (${NAME_RUN}). A divergence means the check read something the key or the affected set does not cover. Find what, and widen it: the store was already rewritten from a cold run, so deleting entries fixes nothing.`,
        "",
        "Reproduce with `./singularity run plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/scripts/dual-check.ts <checkout>` on the tree before, then after, the commit that made the file diverge.",
        "",
        `**Keyed:**\n\`\`\`\n${d.keyed}\n\`\`\``,
        `**Full:**\n\`\`\`\n${d.full}\n\`\`\``,
        "",
        occurrences,
      ].join("\n"),
    };
  },
});
