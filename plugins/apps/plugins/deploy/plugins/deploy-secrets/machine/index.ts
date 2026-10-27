import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { DeploySecretSource } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/server";
import { readCredential } from "./internal/read-credential";

export default {
  description:
    "Deploy secrets, desktop-only half: provides the DeploySecretSource host service by reading $CREDENTIALS_DIRECTORY/<KEY> — the credential systemd decrypted for this service (unset when there is no such directory or file, as on a dev worktree).",
  contributions: [DeploySecretSource.provide({ read: readCredential })],
} satisfies MachinePluginDefinition;
