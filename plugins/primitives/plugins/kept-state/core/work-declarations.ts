import type { ZodType } from "zod";

/**
 * One work-tier owner as `defineKept` declared it, recorded when its module
 * evaluates: what the `kept-state:work-schema-migrates` check reads after
 * importing the modules that declare work (its static scan finds them).
 */
export interface KeptWorkDeclaration {
  owner: string;
  /** The `stamp` literal the declaration carries. */
  stamp: string;
  schema: ZodType<unknown>;
  /** The prior schema stamps its `migrate` reads. */
  migrateFrom: readonly string[];
}

const declared = new Map<string, KeptWorkDeclaration>();

/** Records a work owner — `defineKept` only. */
export function recordKeptWork(declaration: KeptWorkDeclaration): void {
  declared.set(declaration.owner, declaration);
}

/** Every work owner declared by the modules this process has evaluated. */
export function keptWorkDeclarations(): ReadonlyMap<
  string,
  KeptWorkDeclaration
> {
  return declared;
}
