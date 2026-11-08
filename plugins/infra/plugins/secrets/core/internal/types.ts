import { z } from "zod";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { isNamespace } from "@plugins/infra/plugins/namespace/core";

/**
 * Who a secret's value belongs to — declared once, at the namespace's
 * definition, never per call:
 *
 * - `machine`  — the user's: one value for every namespace on this computer
 *   (an OAuth token, a Claude account, a config field's API key). Sign in
 *   once, every worktree works.
 * - `instance` — the instance writing it, like its DB rows (what main deploys:
 *   deploy credentials). Main's value is the base layer; every other namespace
 *   reads through its own overlay and writes only there.
 */
export type SecretScope = "machine" | "instance";
export const SECRET_SCOPES = [
  "machine",
  "instance",
] as const satisfies readonly SecretScope[];

declare const SECRET_NAMESPACE_BRAND: unique symbol;

/**
 * A declared secrets namespace: its id and its scope. Minted only by
 * `defineSecretNamespace`, so a `SecretRef` naming an undeclared namespace — or
 * one whose scope nobody chose — does not compile.
 */
export interface SecretNamespace {
  readonly id: string;
  readonly scope: SecretScope;
  readonly [SECRET_NAMESPACE_BRAND]: true;
}

export interface SecretRef {
  namespace: SecretNamespace;
  key: string;
}

/** The most recent writes an entry remembers. */
export const SECRET_HISTORY_LIMIT = 20;

/**
 * One write to an entry: when, what, by which caller namespace (`null`: a
 * caller that declared none — central's own in-process callers, a CLI), and
 * whether the value differs from the one it replaced. Never a value or a digest.
 */
export const SecretWriteSchema = z.object({
  at: z.number(),
  op: z.enum(["set", "delete"]),
  /** The writer's namespace, validated here so a reader can treat it as one. */
  by: z.string().refine(isNamespace, { message: "not a namespace" }).nullable(),
  changed: z.boolean(),
});
export type SecretWrite = z.infer<typeof SecretWriteSchema>;

export const SecretMetadataSchema = z.object({
  set: z.boolean(),
  updatedAt: z.number().optional(),
  /**
   * Oldest first, the last {@link SECRET_HISTORY_LIMIT} writes. Defaulted: a
   * central built before history existed answers without it.
   */
  history: cappedList(SecretWriteSchema, { max: SECRET_HISTORY_LIMIT }).default(
    [],
  ),
});
/** `{ set, updatedAt?, history }` — never the value. */
export type SecretMetadata = z.infer<typeof SecretMetadataSchema>;
