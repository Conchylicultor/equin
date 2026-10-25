import { getSecret, setSecret } from "@plugins/infra/plugins/secrets/server";

/**
 * Where the fingerprint key lives: the local secrets store, beside the values
 * it fingerprints but in its own namespace, so a value can never be read back
 * as the key nor listed among the secrets.
 */
const HMAC_KEY_REF = { namespace: "deploy-secret-grants", key: "hmac-v1" };

/**
 * A fingerprint of one secret's value: `HMAC-SHA256(local key, key ‖ NUL ‖
 * value)`, hex. Pure over its inputs, so the gate's diff is testable without
 * a store.
 *
 * An HMAC rather than a bare hash because an API key's value space can be
 * small enough to brute-force from a plain digest; under a key that never
 * leaves this machine the fingerprint in the grants table (or in a browser,
 * which the Approve action round-trips) says nothing about the value. The env
 * key is mixed in so one value approved under one name is not approved under
 * another.
 */
export async function fingerprintSecret(
  hmacKey: CryptoKey,
  key: string,
  value: string,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    new TextEncoder().encode(`${key}\u0000${value}`),
  );
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Import raw key bytes (hex) as an HMAC-SHA256 signing key. */
export async function importHmacKey(hex: string): Promise<CryptoKey> {
  const pairs = hex.match(/../g);
  if (pairs === null || hex.length !== 64) {
    throw new Error(
      `[deploy-secrets] the fingerprint key in ${HMAC_KEY_REF.namespace}/${HMAC_KEY_REF.key} is not 32 hex bytes.`,
    );
  }
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(pairs.map((p) => parseInt(p, 16))),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

let keyPromise: Promise<CryptoKey> | undefined;

/**
 * The local fingerprint key, minted (32 random bytes) on first use and kept in
 * the secrets store. Memoized per process; a failed read is not memoized, so
 * the next call tries again rather than failing forever.
 *
 * Losing or replacing this key turns every grant into `changed` — the safe
 * direction: the user re-approves, nothing ships unseen.
 */
export function fingerprintKey(): Promise<CryptoKey> {
  keyPromise ??= loadOrMintKey().catch((err: unknown) => {
    keyPromise = undefined;
    throw err;
  });
  return keyPromise;
}

async function loadOrMintKey(): Promise<CryptoKey> {
  const stored = await getSecret(HMAC_KEY_REF);
  if (stored !== undefined) return importHmacKey(stored);
  const hex = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await setSecret(HMAC_KEY_REF, hex);
  return importHmacKey(hex);
}
