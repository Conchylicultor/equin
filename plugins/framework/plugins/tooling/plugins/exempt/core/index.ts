export type {
  DebtExemption,
  Exemption,
  ExemptionKind,
  Exemptions,
  ResolvedExemption,
  SanctionedExemption,
} from "./types";
export type { ExemptableRuleId } from "./rule-ids.generated";
export {
  FILE_CATEGORIES,
  FILE_CATEGORY_GLOBS,
  NON_APP_FILE_CATEGORIES,
  categoryGlobs,
  isInAnyCategory,
  isInCategory,
} from "./file-category";
export type { FileCategory } from "./file-category";
export {
  covers,
  manifestPathError,
  manifestPathOf,
  resolveManifest,
  resolveTarget,
} from "./resolve";
export {
  exemptManifestPaths,
  isLintRuleId,
  loadExemptions,
  ruleIdProblems,
} from "./load";
export type { ManifestSource } from "./load";
export { createExemptionIndex, describeExemption } from "./matcher";
export type { ExemptionIndex, ExemptionMatcher } from "./matcher";
