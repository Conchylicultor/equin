import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { DeploySecret } from "../../core";

/**
 * A deploy secret as the box sees it. `unset` is a state, never `""`: a dev
 * worktree has no credentials directory, so its consumers record "not
 * configured" rather than mistaking an empty string for a key.
 */
export type DeploySecretValue =
  { kind: "set"; value: string } | { kind: "unset" };

/**
 * Where a deploy secret is read from — the credential files systemd decrypts
 * into the service's credentials directory, so it needs the computer: the
 * provider is this plugin's `machine/` half. Declared in a non-portable barrel,
 * so no browser host needs a provider until one boots this plugin.
 */
export interface DeploySecretSourceImpl {
  /**
   * The secret named `key`, read now. No credentials directory (a dev
   * worktree) or no credential by that name is `unset`; a credential that
   * exists but cannot be read throws — a broken install, not an unconfigured
   * one.
   */
  read(key: string): DeploySecretValue;
}

export const DeploySecretSource = defineHostService<DeploySecretSourceImpl>(
  "deploy-secrets.source",
);

/** Read an approved deploy secret by key. */
export function readDeploySecretKey(key: string): DeploySecretValue {
  return DeploySecretSource.get().read(key);
}

/** Read an approved deploy secret on the box. */
export function readDeploySecret(secret: DeploySecret): DeploySecretValue {
  return readDeploySecretKey(secret.key);
}
