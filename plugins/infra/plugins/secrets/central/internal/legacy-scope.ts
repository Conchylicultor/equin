import type { SecretScope } from "@plugins/infra/plugins/secrets/core";

/**
 * The instance-scoped namespaces that existed when scopes were introduced. A
 * backend built before then (a worktree not yet rebased, talking to main's
 * central) sends no `scope`; its request is resolved from this record, so its
 * writes to these namespaces are refused like any unidentified instance write
 * (it sends no caller header either) — never let through as `machine`.
 *
 * Closed on purpose: a namespace declared after scopes existed is always sent
 * with its scope, so nothing is ever added here.
 */
const PRE_SCOPE_INSTANCE_NAMESPACES: ReadonlySet<string> = new Set([
  "deploy-secrets",
  "deploy-ssh",
  "deploy-secret-grants",
]);

/** A request that names a known instance namespace with another scope. */
export class ScopeMismatchError extends Error {
  override readonly name = "ScopeMismatchError";
}

export function resolveScope(
  namespace: string,
  sent: SecretScope | undefined,
): SecretScope {
  const preScopeInstance = PRE_SCOPE_INSTANCE_NAMESPACES.has(namespace);
  // A request claiming `machine` for one of these would write main's base
  // from anywhere: the record is authoritative, so the claim is refused.
  if (sent === "machine" && preScopeInstance) {
    throw new ScopeMismatchError(
      `secrets namespace "${namespace}" is instance-scoped; a request sent it as "machine".`,
    );
  }
  if (sent !== undefined) return sent;
  return preScopeInstance ? "instance" : "machine";
}
