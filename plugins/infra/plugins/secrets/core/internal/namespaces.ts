import type { SecretNamespace, SecretScope } from "./types";

const NAMESPACE_ID_RE = /^[a-z][a-z0-9-]*$/;

/** Every namespace this process declared, by id — so one id cannot carry two scopes. */
const declared = new Map<string, SecretScope>();

/**
 * Declare a secrets namespace and the scope its values have (see
 * {@link SecretScope}). Declared once, by the plugin owning it; every
 * `SecretRef` names the result, so the scope travels with every request and is
 * never chosen per call.
 *
 * Idempotent for the same scope (two halves of one plugin may each declare
 * it); a second declaration with ANOTHER scope throws — one namespace's values
 * would land in two places.
 */
export function defineSecretNamespace(
  id: string,
  opts: { scope: SecretScope },
): SecretNamespace {
  if (!NAMESPACE_ID_RE.test(id)) {
    throw new Error(
      `[secrets] namespace id "${id}" must be lowercase-hyphen (${NAMESPACE_ID_RE}).`,
    );
  }
  const prior = declared.get(id);
  if (prior !== undefined && prior !== opts.scope) {
    throw new Error(
      `[secrets] namespace "${id}" is declared both "${prior}" and "${opts.scope}" — one namespace has one scope.`,
    );
  }
  declared.set(id, opts.scope);
  return { id, scope: opts.scope } as SecretNamespace;
}

/**
 * The request header a backend stamps with its own namespace on every call to
 * central's store. The caller's own claim — an accident guard against our own
 * code writing another instance's secrets, not authentication.
 */
export const SECRETS_CALLER_HEADER = "x-equin-secrets-caller";
