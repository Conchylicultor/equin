import { callEndpoint } from "@plugins/infra/plugins/endpoints/server";
import { EndpointError } from "@plugins/infra/plugins/endpoints/core";
import type {
  SecretMetadata,
  SecretRef,
} from "@plugins/infra/plugins/secrets/core";
import {
  secretsDelete,
  secretsGet,
  secretsHas,
  secretsList,
  secretsMeta,
  secretsSet,
  SecretsMainOfflineError,
} from "@plugins/infra/plugins/secrets/core";

/** Central's routes are served by the gateway on every host name. */
const CENTRAL_ORIGIN = "http://localhost:9000";
const RETRY_DELAY_MS = 250;

/**
 * Send one request to central's secrets API; central being unreachable — no
 * answer twice, a gateway 502/503/504, or the gateway's own 404 before the
 * central-routes manifest has loaded — is `SecretsMainOfflineError`.
 */
async function toCentral<T>(send: () => Promise<T>): Promise<T> {
  try {
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      // One retry, then surface as offline — "central is unreachable" is the
      // failure mode that matters; transient blips collapse into one retry.
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return await send();
    }
  } catch (err) {
    if (err instanceof TypeError) throw new SecretsMainOfflineError();
    if (err instanceof EndpointError && isCentralOffline(err)) {
      throw new SecretsMainOfflineError();
    }
    throw err;
  }
}

function isCentralOffline(err: EndpointError): boolean {
  if (err.status === 502 || err.status === 503 || err.status === 504) {
    return true;
  }
  // The gateway answers this exact text while the central-routes manifest
  // hasn't loaded yet.
  return (
    err.status === 404 &&
    typeof err.body === "string" &&
    err.body.includes("Singularity gateway")
  );
}

export async function getSecret(ref: SecretRef): Promise<string | undefined> {
  const { value } = await toCentral(() =>
    callEndpoint(secretsGet, {}, { origin: CENTRAL_ORIGIN, body: ref }),
  );
  return value ?? undefined;
}

export async function setSecret(ref: SecretRef, value: string): Promise<void> {
  await toCentral(() =>
    callEndpoint(
      secretsSet,
      {},
      { origin: CENTRAL_ORIGIN, body: { ...ref, value } },
    ),
  );
}

export async function deleteSecret(ref: SecretRef): Promise<void> {
  await toCentral(() =>
    callEndpoint(secretsDelete, {}, { origin: CENTRAL_ORIGIN, body: ref }),
  );
}

export async function hasSecret(ref: SecretRef): Promise<boolean> {
  const { has } = await toCentral(() =>
    callEndpoint(secretsHas, {}, { origin: CENTRAL_ORIGIN, body: ref }),
  );
  return has;
}

export async function getSecretMetadata(
  ref: SecretRef,
): Promise<SecretMetadata> {
  return toCentral(() =>
    callEndpoint(secretsMeta, {}, { origin: CENTRAL_ORIGIN, body: ref }),
  );
}

export async function listKeysInNamespace(namespace: string): Promise<string[]> {
  const { keys } = await toCentral(() =>
    callEndpoint(
      secretsList,
      {},
      { origin: CENTRAL_ORIGIN, body: { namespace } },
    ),
  );
  return keys;
}
