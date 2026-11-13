import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { extensionStanding } from "../internal/standing";
import { useExtensionState } from "../internal/status";

/**
 * The browser extension's Accounts pane body: where it stands, and the folder
 * to load it from once (`chrome://extensions` → Developer mode → Load
 * unpacked). It updates itself after that.
 */
export function ExtensionSetup() {
  const state = useExtensionState();
  if (state.status === "unavailable")
    return (
      <Text variant="caption" tone="muted">
        {state.message}
      </Text>
    );
  return foldResource(state, {
    loading: () => <Loading variant="block" className="h-16 w-full" />,
    error: (error) => {
      throw error;
    },
    ready: ({ shell, connection }) => {
      const standing = extensionStanding(shell, connection);
      return (
        <Stack gap="sm">
          <Text as="div">
            {standing.kind === "not-built"
              ? "Not built yet: the next build writes it."
              : standing.kind === "not-connected"
                ? "Not connected: load it in Chrome once, then open it from the toolbar."
                : standing.kind === "up-to-date"
                  ? `Connected · up to date · opened ${formatRelativeTime(new Date(standing.seenAt))}`
                  : `Update pending · opened ${formatRelativeTime(new Date(standing.seenAt))} on an older shell; it updates the next time it opens`}
          </Text>
          <Stack gap="2xs">
            <Text as="div" variant="caption" tone="muted">
              Install once: chrome://extensions → Developer mode → Load unpacked
              → this folder.
            </Text>
            <Stack direction="row" gap="xs" align="center">
              <Text as="code" variant="code">
                {shell.path}
              </Text>
              <CopyButton text={shell.path} tooltip="Copy the folder" />
            </Stack>
          </Stack>
        </Stack>
      );
    },
  });
}
