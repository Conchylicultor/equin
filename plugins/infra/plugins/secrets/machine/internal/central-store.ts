import { callEndpoint } from "@plugins/infra/plugins/endpoints/server";
import { EndpointError } from "@plugins/infra/plugins/endpoints/core";
import type { SecretStoreImpl } from "@plugins/infra/plugins/secrets/server";
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
  // The gateway answers "<product> gateway. Use <name>.localhost." while the
  // central-routes manifest hasn't loaded yet. Matched on the part after the
  // product name, so a gateway binary built before the rename (which still says
  // its old name) is recognised too.
  return (
    err.status === 404 &&
    typeof err.body === "string" &&
    err.body.includes("gateway. Use <name>.localhost")
  );
}

/**
 * The secrets store on the computer: central's encrypted store, reached over
 * HTTP through the gateway (central's `/api/secrets/*` routes answer on every
 * host name). Central unreachable is `SecretsMainOfflineError`.
 */
export const centralSecretStore: SecretStoreImpl = {
  async get(ref) {
    const { value } = await toCentral(() =>
      callEndpoint(secretsGet, {}, { origin: CENTRAL_ORIGIN, body: ref }),
    );
    return value ?? undefined;
  },
  async set(ref, value) {
    await toCentral(() =>
      callEndpoint(
        secretsSet,
        {},
        { origin: CENTRAL_ORIGIN, body: { ...ref, value } },
      ),
    );
  },
  async delete(ref) {
    await toCentral(() =>
      callEndpoint(secretsDelete, {}, { origin: CENTRAL_ORIGIN, body: ref }),
    );
  },
  async has(ref) {
    const { has } = await toCentral(() =>
      callEndpoint(secretsHas, {}, { origin: CENTRAL_ORIGIN, body: ref }),
    );
    return has;
  },
  metadata(ref) {
    return toCentral(() =>
      callEndpoint(secretsMeta, {}, { origin: CENTRAL_ORIGIN, body: ref }),
    );
  },
  async listKeys(namespace) {
    const { keys } = await toCentral(() =>
      callEndpoint(
        secretsList,
        {},
        { origin: CENTRAL_ORIGIN, body: { namespace } },
      ),
    );
    return keys;
  },
};
