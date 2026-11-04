import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { DeploySecretValue } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/server";

/**
 * The directory systemd decrypts this service's credentials into
 * (`LoadCredentialEncrypted=`), named by the variable systemd sets on the
 * unit's main process — forwarded down the runtime tree as a host fact
 * (`launcher/core` `RUNTIME_HOST_ENV`). Undefined anywhere but a deployed box.
 */
function credentialsDirectory(): AppPath | undefined {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  // systemd's own credentials dir, set for the unit: app-owned.
  return dir === undefined || dir === "" ? undefined : asAppPath(dir);
}

/** The credential named `key`, as `DeploySecretSourceImpl.read` defines it. */
export function readCredential(key: string): DeploySecretValue {
  const dir = credentialsDirectory();
  if (dir === undefined) return { kind: "unset" };
  let value: string;
  try {
    value = readFileSync(joinAppPath(dir, key), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "unset" };
    }
    throw err;
  }
  return value === "" ? { kind: "unset" } : { kind: "set", value };
}
