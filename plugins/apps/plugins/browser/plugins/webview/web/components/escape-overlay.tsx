import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";

const closeIcon = symbol("close");
const publicOffIcon = symbol("public-off");
const refreshIcon = symbol("refresh");

interface EscapeOverlayProps {
  /** The last known real URL (the page that triggered the escape). */
  url: string;
  /** Reload the source page through the proxy. */
  onReload(): void;
  /** Dismiss the overlay to reveal whatever the frame currently shows. */
  onDismiss(): void;
}

/**
 * Shown when a proxied page self-navigates out of the proxy (a JS `location`
 * assignment or scripted `form.submit()` — escapes the in-page shim can't
 * intercept) and lands on an un-proxied document that re-blocks framing, leaving
 * a blank frame. We can't learn the escape's destination (no `commit`, and the
 * cross-origin frame is unreadable), so "Open in system browser" reopens the
 * source `url`; the real browser then re-runs the same redirect with no framing
 * restriction and lands the user where the page intended.
 */
export function EscapeOverlay({
  url,
  onReload,
  onDismiss,
}: EscapeOverlayProps) {
  return (
    <Center
      axis="both"
      className="h-full w-full bg-background/85 backdrop-blur-sm"
    >
      <Surface level="overlay" className="relative max-w-sm">
        <Pin to="top-right" offset="xs">
          <IconButton
            icon={closeIcon}
            label="Dismiss"
            tooltip="Dismiss"
            onClick={onDismiss}
          />
        </Pin>
        <Inset pad="xl">
          <Stack
            direction="col"
            gap="md"
            align="center"
            className="text-center"
          >
            <Text variant="heading" tone="muted" as="span">
              <Icon icon={publicOffIcon} className="icon-auto" aria-hidden />
            </Text>
            <Text variant="subheading">This page can't be shown here</Text>
            <Text variant="body" tone="muted">
              It navigated to a site that blocks embedding. Open it in your
              system browser to keep going.
            </Text>
            <Stack direction="row" gap="sm" align="center">
              <NewTabButton href={url} disabled={url === ""}>
                Open in system browser
              </NewTabButton>
              <Button variant="outline" onClick={onReload}>
                <Icon icon={refreshIcon} className="icon-auto" aria-hidden />
                Reload
              </Button>
            </Stack>
          </Stack>
        </Inset>
      </Surface>
    </Center>
  );
}
