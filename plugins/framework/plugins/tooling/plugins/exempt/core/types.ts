import type { DebtableRuleId, ExemptableRuleId } from "./rule-ids.generated";

/**
 * One exemption, as a plugin declares it in its own `exempt/index.ts`: these
 * of MY files may violate `rule`, and why.
 *
 * `paths` are relative to the declaring plugin's directory. Each is a file or
 * a directory (its whole subtree, child plugins included); `"."` is the whole
 * plugin. No globs, and no `..` or absolute path: a plugin can only exempt its
 * own files, which is what makes the exemption the exempted plugin's to own.
 */
export type Exemption = SanctionedExemption | DebtExemption;

interface ExemptionBase {
  /** A contributed lint rule (`<ns>/<rule>`) or an id a check declares `exemptable`. */
  rule: ExemptableRuleId;
  paths: readonly string[];
  /** Why these files may violate the rule — the sentence a reviewer reads. */
  reason: string;
}

/** A permanent, legitimate use: the one sanctioned home of an idiom. */
export interface SanctionedExemption extends ExemptionBase {
  kind: "sanctioned";
}

/** A violation that should not exist and is tracked for removal. */
export interface DebtExemption extends ExemptionBase {
  kind: "debt";
  /** Any exemptable id but one its owner declares `noDebt` (sanctioned-only). */
  rule: DebtableRuleId;
  /** The task that removes it. */
  task: string;
}

export type ExemptionKind = Exemption["kind"];

/** What an `exempt/index.ts` default-exports: `[...] satisfies Exemptions`. */
export type Exemptions = readonly Exemption[];

/**
 * One path of one declared exemption, resolved against the repo. Matching is
 * by repo-relative prefix: `target` covers itself and, when it is a
 * directory, everything under it.
 */
export type ResolvedExemption =
  | (ResolvedBase & { kind: "sanctioned" })
  | (ResolvedBase & { kind: "debt"; task: string });

interface ResolvedBase {
  /** The rule id exactly as declared (validated against the live rule set by `exempt:manifests-valid`). */
  rule: string;
  /** The declaring plugin, relative to `plugins/` (`infra/plugins/jobs`). */
  plugin: string;
  /** Repo-relative path of the declaring manifest (`plugins/<plugin>/exempt/index.ts`). */
  manifest: string;
  /** The path as written in the manifest (`server/internal/x.ts`, `"."`). */
  path: string;
  /** Repo-relative resolved path (`plugins/<plugin>/server/internal/x.ts`). */
  target: string;
  reason: string;
}
