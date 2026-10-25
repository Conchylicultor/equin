import type { DeploySecret } from "../../core";

/**
 * A deploy secret as the box sees it. `unset` is a state, never `""`: a dev
 * worktree has no deployment env file, so its consumers record "not
 * configured" rather than mistaking an empty string for a key.
 */
export type DeploySecretValue =
  { kind: "set"; value: string } | { kind: "unset" };

/** Read an approved deploy secret from the box's environment. */
export function readDeploySecret(secret: DeploySecret): DeploySecretValue {
  const value = process.env[secret.key];
  return value === undefined || value === ""
    ? { kind: "unset" }
    : { kind: "set", value };
}
