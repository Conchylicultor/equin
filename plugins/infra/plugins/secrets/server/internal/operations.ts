import type {
  SecretMetadata,
  SecretRef,
} from "@plugins/infra/plugins/secrets/core";
import { SecretsMainOfflineError } from "@plugins/infra/plugins/secrets/core";

const GATEWAY_BASE = "http://localhost:9000";
const RETRY_DELAY_MS = 250;

interface GetResponse {
  value: string | null;
}
interface HasResponse {
  has: boolean;
}
interface ListResponse {
  keys: string[];
}

/** POST to central's secrets API; the response once it is a 2xx. */
async function post(path: string, body: unknown): Promise<Response> {
  const url = `${GATEWAY_BASE}${path}`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    // One retry, then surface as offline. Mirrors the previous unix-socket
    // client's behavior — "central is unreachable" is the failure mode that
    // matters; transient blips collapse into one retry.
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      res = await fetch(url, init);
    } catch (retryErr) {
      if (!(retryErr instanceof TypeError)) throw retryErr;
      throw new SecretsMainOfflineError();
    }
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new SecretsMainOfflineError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Gateway returns this exact text when the central-routes manifest hasn't
    // loaded yet — treat as offline so callers can degrade gracefully.
    if (res.status === 404 && text.includes("Singularity gateway")) {
      throw new SecretsMainOfflineError();
    }
    throw new Error(`secrets api ${path}: ${res.status} ${text}`);
  }
  return res;
}

/** A read: central answers with a JSON body. */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  return (await (await post(path, body)).json()) as T;
}

/** A write: central answers 204 (its handler returns nothing), no body. */
async function postVoid(path: string, body: unknown): Promise<void> {
  const res = await post(path, body);
  if (res.status !== 204)
    throw new Error(`secrets api ${path}: expected 204, got ${res.status}`);
}

export async function getSecret(ref: SecretRef): Promise<string | undefined> {
  const { value } = await postJson<GetResponse>("/api/secrets/get", ref);
  return value ?? undefined;
}

export async function setSecret(ref: SecretRef, value: string): Promise<void> {
  await postVoid("/api/secrets/set", { ...ref, value });
}

export async function deleteSecret(ref: SecretRef): Promise<void> {
  await postVoid("/api/secrets/delete", ref);
}

export async function hasSecret(ref: SecretRef): Promise<boolean> {
  const { has } = await postJson<HasResponse>("/api/secrets/has", ref);
  return has;
}

export async function getSecretMetadata(
  ref: SecretRef,
): Promise<SecretMetadata> {
  return postJson<SecretMetadata>("/api/secrets/meta", ref);
}

export async function listKeysInNamespace(namespace: string): Promise<string[]> {
  const { keys } = await postJson<ListResponse>("/api/secrets/list", {
    namespace,
  });
  return keys;
}
