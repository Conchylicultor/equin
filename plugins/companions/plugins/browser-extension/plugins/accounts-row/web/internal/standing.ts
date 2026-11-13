import type {
  ConnectionState,
  ShellState,
} from "@plugins/companions/plugins/browser-extension/core";

/** Where the extension stands: built or not, opened or not, current or not. */
export type ExtensionStanding =
  | { kind: "not-built" }
  | { kind: "not-connected" }
  | { kind: "up-to-date"; seenAt: number }
  | { kind: "update-pending"; seenAt: number };

export function extensionStanding(
  shell: ShellState,
  connection: ConnectionState,
): ExtensionStanding {
  if (shell.kind === "absent") return { kind: "not-built" };
  if (connection.kind === "never") return { kind: "not-connected" };
  return connection.shellDigest === shell.digest
    ? { kind: "up-to-date", seenAt: connection.seenAt }
    : { kind: "update-pending", seenAt: connection.seenAt };
}
