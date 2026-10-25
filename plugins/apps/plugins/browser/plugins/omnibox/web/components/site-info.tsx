import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  Browser,
  Favicon,
  useBrowserProxy,
} from "@plugins/apps/plugins/browser/plugins/shell/web";

const lockIcon = symbol("lock");
const shieldIcon = symbol("shield");

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch (err) {
    if (err instanceof TypeError) return url; // not a URL — show it raw
    throw err;
  }
}

/**
 * The address pill's leading button: a lock, or a shield while pages load
 * through the framing-stripping proxy. It opens the site-info popover — the
 * host, then every contributed `Browser.SiteInfo` row (the proxy switch, …).
 */
export function SiteInfoButton({ url }: { url: string }) {
  const { enabled } = useBrowserProxy();
  return (
    <InlinePopover
      width="menu"
      trigger={
        <IconButton
          icon={enabled ? shieldIcon : lockIcon}
          label="Site information"
          tooltip="Site information"
        />
      }
    >
      <Stack gap="sm">
        <Line className="gap-sm">
          <Favicon url={url} size={20} />
          <Fill>
            <Stack gap="none">
              <Text variant="label">{hostOf(url)}</Text>
              <Text variant="caption" tone="muted">
                {enabled ? "Loaded through the proxy" : "Loaded directly"}
              </Text>
            </Stack>
          </Fill>
        </Line>
        <Browser.SiteInfo.Render />
      </Stack>
    </InlinePopover>
  );
}
