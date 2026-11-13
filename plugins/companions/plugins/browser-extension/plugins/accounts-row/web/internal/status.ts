import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  useCombinedResources,
  type ResourceResult,
  type ResourceUnavailable,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { IntegrationStatus } from "@plugins/auth/web";
import {
  browserExtensionConnection,
  browserExtensionShell,
  type ConnectionState,
  type ShellState,
} from "@plugins/companions/plugins/browser-extension/core";
import { extensionStanding, type ExtensionStanding } from "./standing";

/** The shell and its connection, read live together. */
export function useExtensionState():
  | ResourceResult<{
      shell: ShellState;
      connection: ConnectionState;
    }>
  | ResourceUnavailable {
  return useCombinedResources({
    shell: useLive(browserExtensionShell),
    connection: useLive(browserExtensionConnection),
  });
}

const STATUS: Record<ExtensionStanding["kind"], IntegrationStatus> = {
  "not-built": { tone: "muted", label: "Not built" },
  "not-connected": { tone: "muted", label: "Not connected" },
  "up-to-date": { tone: "success", label: "Connected · up to date" },
  "update-pending": { tone: "warning", label: "Update pending" },
};

/** The Accounts row's badge. */
export function useExtensionStatus():
  ResourceResult<IntegrationStatus> | ResourceUnavailable {
  return mapResource(useExtensionState(), ({ shell, connection }) => {
    const standing = extensionStanding(shell, connection);
    return {
      ...STATUS[standing.kind],
      ...(shell.kind === "built" ? { summary: shell.path } : {}),
    };
  });
}
