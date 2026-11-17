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
// Central's routes are served by the gateway on every host name: this
// account's gateway (the one that started this process, else the recorded port).
import { resolveGatewayOrigin } from "@plugins/infra/plugins/launcher/plugins/gateway-port/machine";
import {
  hasRuntimeNamespace,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";

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
  // Central answers on this account's gateway port, resolved per request: a
  // backend reads the gateway that started it, a CLI the account's record.
  const send = <T>(
    call: (headers: Record<string, string>, origin: string) => Promise<T>,
  ) => {
    const ns = caller();
    return toCentral(async () =>
      call(
        ns === null ? {} : { [SECRETS_CALLER_HEADER]: ns },
        await resolveGatewayOrigin(),
      ),
    );
  };
  return {
    async get(ref) {
      const { value } = await send((headers, origin) =>
        callEndpoint(secretsGet, {}, { origin, headers, body: refBody(ref) }),
      );
      return value ?? undefined;
    },
    async set(ref, value) {
      await send((headers, origin) =>
        callEndpoint(
          secretsSet,
          {},
          { origin, headers, body: { ...refBody(ref), value } },
        ),
      );
    },
    async delete(ref) {
      await send((headers, origin) =>
        callEndpoint(
          secretsDelete,
          {},
          { origin, headers, body: refBody(ref) },
        ),
      );
    },
    async has(ref) {
      const { has } = await send((headers, origin) =>
        callEndpoint(secretsHas, {}, { origin, headers, body: refBody(ref) }),
      );
      return has;
    },
    metadata(ref) {
      return send((headers, origin) =>
        callEndpoint(secretsMeta, {}, { origin, headers, body: refBody(ref) }),
      );
    },
    async listKeys(namespace) {
      const { keys } = await send((headers, origin) =>
        callEndpoint(
          secretsList,
          {},
          {
            origin,
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
