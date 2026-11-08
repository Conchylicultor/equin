import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type {
  SecretMetadata,
  SecretNamespace,
  SecretRef,
} from "@plugins/infra/plugins/secrets/core";

/**
 * Where the secrets live, as this host reaches them. On the computer it is the
 * central runtime (the encrypted blob, the keychain), reached over HTTP
 * through the gateway — this plugin's `machine/` half. There is no browser
 * provider: a host without the computer has no secrets store, so (portability
 * rule 3, `boundaries/core`) this barrel and every server barrel loading it
 * are not portable, and no browser host boots them.
 *
 * A process that runs this code WITHOUT booting a graph (a `./equin` verb, an
 * agent process) names the provider itself:
 * `provideHostServicesUnbooted([SecretStore.provide(centralSecretStore)])`,
 * `centralSecretStore` from `infra/secrets/cli` (or `centralSecretStoreFor(ns)`
 * when it acts for a namespace it knows but did not declare).
 *
 * Every ref names a declared `SecretNamespace`; an `instance` one is read and
 * written in the caller's own layer (main's is the base) — see the plugin's
 * CLAUDE.md.
 */
export interface SecretStoreImpl {
  get(ref: SecretRef): Promise<string | undefined>;
  set(ref: SecretRef, value: string): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
  has(ref: SecretRef): Promise<boolean>;
  metadata(ref: SecretRef): Promise<SecretMetadata>;
  listKeys(namespace: SecretNamespace): Promise<string[]>;
}

export const SecretStore = defineHostService<SecretStoreImpl>("secrets.store");

export function getSecret(ref: SecretRef): Promise<string | undefined> {
  return SecretStore.get().get(ref);
}

export function setSecret(ref: SecretRef, value: string): Promise<void> {
  return SecretStore.get().set(ref, value);
}

export function deleteSecret(ref: SecretRef): Promise<void> {
  return SecretStore.get().delete(ref);
}

export function hasSecret(ref: SecretRef): Promise<boolean> {
  return SecretStore.get().has(ref);
}

/** `{ set, updatedAt?, history }` — never the value. */
export function getSecretMetadata(ref: SecretRef): Promise<SecretMetadata> {
  return SecretStore.get().metadata(ref);
}

export function listKeysInNamespace(
  namespace: SecretNamespace,
): Promise<string[]> {
  return SecretStore.get().listKeys(namespace);
}
