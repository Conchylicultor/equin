import type { ReactElement } from "react";
import {
  Button,
  DialogTitle,
  DialogDescription,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { Server } from "../../shared";

/**
 * Same guard as the ssh-setup install command's: the `sed` argument is a REGEX,
 * so a comment carrying regex metacharacters would match lines it was never
 * meant to. Duplicated rather than imported because ssh-setup depends on this
 * plugin — importing back would close a cycle.
 */
const SAFE_COMMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Confirm body for deleting a server. Deleting the row is the *only* thing this
 * app can do: the `authorized_keys` line it installed lives on a machine we
 * have no way to reach once the private key is gone, so the copy says so and
 * hands over the one-liner that removes it. This is the one place a standalone
 * removal command genuinely helps — everywhere else it rides along with the
 * install command the user runs anyway.
 */
export function DeleteServerDialog({
  server,
  onCancel,
  onConfirm,
}: {
  server: Server;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}): ReactElement {
  const comment = server.sshKey?.comment;
  const removeCommand =
    comment && SAFE_COMMENT.test(comment)
      ? `sed -i.bak '/ ${comment}$/d' ~/.ssh/authorized_keys`
      : null;

  return (
    <Stack gap="md">
      <Stack gap="xs">
        <DialogTitle>Delete {server.name}?</DialogTitle>
        <DialogDescription>
          {server.sshKey
            ? "The stored private key is destroyed permanently — it cannot be recovered."
            : "The server is removed from this app. Nothing on the server itself changes."}
        </DialogDescription>
        {server.sshKey && (
          <Text as="p" variant="body" tone="muted">
            The line this app added to the server&apos;s{" "}
            <Text as="code" variant="body">
              authorized_keys
            </Text>{" "}
            stays there — deleting the key here does not reach the machine.
            {removeCommand && " Run this on the server to remove it:"}
          </Text>
        )}
      </Stack>
      {removeCommand && (
        <Stack direction="row" align="start" gap="sm">
          <Fill>
            <Text
              as="code"
              variant="caption"
              className="rounded-md bg-muted px-sm py-xs break-all"
            >
              {removeCommand}
            </Text>
          </Fill>
          <CopyButton text={removeCommand} tooltip="Copy removal command" />
        </Stack>
      )}
      <Stack direction="row" align="center" gap="sm">
        <Fill />
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          Delete server
        </Button>
      </Stack>
    </Stack>
  );
}
