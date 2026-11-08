// In-process API for other central plugins. The HTTP routes in `handlers.ts`
// handle calls from worktree backends through the gateway; sibling central
// plugins (auth) skip the round-trip and call these wrappers directly.
//
// Each operation awaits `ready` before touching the store so a caller's
// onReady can run in any order relative to secrets's onReady.
//
// Central serves every namespace and runs as none, so it has no layer of its
// own in an instance namespace: these wrappers take machine namespaces only,
// and throw on an instance one (a backend reads and writes those, over HTTP).

import type {
  SecretMetadata,
  SecretNamespace,
  SecretRef,
} from "@plugins/infra/plugins/secrets/core";
import { ready } from "./boot";
import {
  deleteLocal,
  getLocal,
  getMetadataLocal,
  hasLocal,
  listKeysLocal,
  setLocal,
  type Access,
} from "./store";

function centralAccess(namespace: SecretNamespace): Access {
  if (namespace.scope !== "machine") {
    throw new Error(
      `[secrets] central has no namespace of its own, so it cannot read or write the instance-scoped "${namespace.id}" — a backend does, over /api/secrets/*.`,
    );
  }
  return { scope: "machine", caller: null };
}

export async function getSecret(ref: SecretRef): Promise<string | undefined> {
  const access = centralAccess(ref.namespace);
  await ready;
  return getLocal(access, ref.namespace.id, ref.key);
}

export async function setSecret(ref: SecretRef, value: string): Promise<void> {
  const access = centralAccess(ref.namespace);
  await ready;
  await setLocal(access, ref.namespace.id, ref.key, value);
}

export async function deleteSecret(ref: SecretRef): Promise<void> {
  const access = centralAccess(ref.namespace);
  await ready;
  await deleteLocal(access, ref.namespace.id, ref.key);
}

export async function hasSecret(ref: SecretRef): Promise<boolean> {
  const access = centralAccess(ref.namespace);
  await ready;
  return hasLocal(access, ref.namespace.id, ref.key);
}

export async function getSecretMetadata(
  ref: SecretRef,
): Promise<SecretMetadata> {
  const access = centralAccess(ref.namespace);
  await ready;
  return getMetadataLocal(access, ref.namespace.id, ref.key);
}

export async function listKeysInNamespace(
  namespace: SecretNamespace,
): Promise<string[]> {
  const access = centralAccess(namespace);
  await ready;
  return listKeysLocal(access, namespace.id);
}
