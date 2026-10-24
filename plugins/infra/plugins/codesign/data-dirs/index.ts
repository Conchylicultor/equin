import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The machine's code-signing state: `local/` (the local identity — a
 * self-signed certificate and its private key, `cert.pem` / `key.pem`), and
 * optionally `identity` (the SHA-1 or exact name of a keychain identity to sign
 * with instead). Kept 0700, the key 0600.
 */
export const codesignDir = defineDataDir({
  kind: "state",
  name: "codesign",
  owner: "infra/codesign",
  description:
    "local/ — this machine's self-signed code-signing certificate and key the gateway is signed with; identity — an optional configured keychain identity",
  // macOS keys every permission grant (Downloads, …) to the certificate: a new
  // one, re-derived after a delete, is a different signer, so every grant the
  // gateway holds is lost and asked for again.
  reclaim: {
    kind: "never",
    reason:
      "macOS permission grants are keyed to this certificate; re-creating it drops every one",
  },
});

export default [codesignDir];
