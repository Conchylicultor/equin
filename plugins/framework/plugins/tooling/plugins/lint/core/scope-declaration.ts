import {
  FILE_CATEGORIES,
  type FileCategory,
} from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import type { LintContribution } from "./build-lint-config";

type ScopeDeclaration = Pick<
  LintContribution,
  "enforceEverywhere" | "outOfScope" | "closed" | "noDebt"
>;

const isCategory = (c: unknown): c is FileCategory =>
  (FILE_CATEGORIES as readonly unknown[]).includes(c);

/**
 * What is wrong with a lint barrel's scope declaration, or null when nothing
 * is: a rule id in `enforceEverywhere` / `outOfScope` / `closed` / `noDebt`
 * that the barrel does not define (a typo would silently change nothing —
 * exactly the failure each key exists to prevent), a rule both `closed` and
 * `noDebt`, or an unknown file category.
 */
export function scopeDeclarationError(
  def: ScopeDeclaration,
  rules: Readonly<Record<string, unknown>>,
): string | null {
  const outOfScope = def.outOfScope ?? {};
  const named: (readonly [key: string, id: string])[] = [
    ...(def.enforceEverywhere ?? []).map(
      (id) => ["enforceEverywhere", id] as const,
    ),
    ...Object.keys(outOfScope).map((id) => ["outOfScope", id] as const),
    ...(def.closed ?? []).map((id) => ["closed", id] as const),
    ...(def.noDebt ?? []).map((id) => ["noDebt", id] as const),
  ];
  const unknown = named.filter(([, id]) => !(id in rules));
  if (unknown.length > 0) {
    return `names rule(s) this plugin does not define: ${unknown.map(([k, id]) => `${k} "${id}"`).join(", ")}`;
  }
  // `closed` already refuses both kinds; naming a rule in both is a
  // contradiction about what the rule admits, not a harmless redundancy.
  const closed = new Set(def.closed ?? []);
  const both = (def.noDebt ?? []).filter((id) => closed.has(id));
  if (both.length > 0) {
    return `declares rule(s) both closed and noDebt: ${both.map((id) => `"${id}"`).join(", ")} — closed admits no exemption at all, noDebt admits sanctioned ones only; pick one`;
  }
  const badCategories = Object.entries(outOfScope).flatMap(([id, cats]) =>
    cats.filter((c) => !isCategory(c)).map((c) => `${id}: "${String(c)}"`),
  );
  if (badCategories.length > 0) {
    return `outOfScope names unknown file categories (${badCategories.join(", ")}); known: ${FILE_CATEGORIES.join(", ")}`;
  }
  return null;
}
