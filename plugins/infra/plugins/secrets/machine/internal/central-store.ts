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
  SECRETS_CALLER_HEADER,
  type SecretRef,
  type SecretScope,
} from "@plugins/infra/plugins/secrets/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import {
  hasRuntimeNamespace,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";

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

/** The wire form of a ref: the namespace's id and its declared scope, plus the key. */
function refBody(ref: SecretRef): {
  namespace: string;
  scope: SecretScope;
  key: string;
} {
  return {
    namespace: ref.namespace.id,
    scope: ref.namespace.scope,
    key: ref.key,
  };
}

/**
 * A client of central's store that stamps every request with `caller()` — the
 * namespace whose layer an instance namespace reads and writes (main's is the
 * base). `null`: a process that declared none — it reads the base, and central
 * refuses its writes to an instance namespace.
 */
function centralStoreAs(caller: () => Namespace | null): SecretStoreImpl {
  const send = <T>(call: (headers: Record<string, string>) => Promise<T>) => {
    const ns = caller();
    return toCentral(() =>
      call(ns === null ? {} : { [SECRETS_CALLER_HEADER]: ns }),
    );
  };
  return {
    async get(ref) {
      const { value } = await send((headers) =>
        callEndpoint(
          secretsGet,
          {},
          { origin: CENTRAL_ORIGIN, headers, body: refBody(ref) },
        ),
      );
      return value ?? undefined;
    },
    async set(ref, value) {
      await send((headers) =>
        callEndpoint(
          secretsSet,
          {},
          { origin: CENTRAL_ORIGIN, headers, body: { ...refBody(ref), value } },
        ),
      );
    },
    async delete(ref) {
      await send((headers) =>
        callEndpoint(
          secretsDelete,
          {},
          { origin: CENTRAL_ORIGIN, headers, body: refBody(ref) },
        ),
      );
    },
    async has(ref) {
      const { has } = await send((headers) =>
        callEndpoint(
          secretsHas,
          {},
          { origin: CENTRAL_ORIGIN, headers, body: refBody(ref) },
        ),
      );
      return has;
    },
    metadata(ref) {
      return send((headers) =>
        callEndpoint(
          secretsMeta,
          {},
          { origin: CENTRAL_ORIGIN, headers, body: refBody(ref) },
        ),
      );
    },
    async listKeys(namespace) {
      const { keys } = await send((headers) =>
        callEndpoint(
          secretsList,
          {},
          {
            origin: CENTRAL_ORIGIN,
            headers,
            body: { namespace: namespace.id, scope: namespace.scope },
          },
        ),
      );
      return keys;
    },
  };
}

/**
 * The secrets store on the computer: central's encrypted store, reached over
 * HTTP through the gateway (central's `/api/secrets/*` routes answer on every
 * host name), as THIS process's runtime namespace — read per call, so a
 * process that declares none (an agent process) is an unidentified caller.
 * Central unreachable is `SecretsMainOfflineError`.
 */
export const centralSecretStore: SecretStoreImpl = centralStoreAs(() =>
  hasRuntimeNamespace() ? runtimeNamespace() : null,
);

/**
 * Central's store as a namespace the process names itself: a CLI acting on a
 * checkout has no runtime namespace but knows whose secrets it reads
 * (`./equin deploy` reads its checkout's SSH key, which a worktree keeps in
 * its own layer).
 */
export function centralSecretStoreFor(namespace: Namespace): SecretStoreImpl {
  return centralStoreAs(() => namespace);
}
