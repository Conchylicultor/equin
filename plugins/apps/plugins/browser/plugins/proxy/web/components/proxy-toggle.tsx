import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { useBrowserProxy } from "@plugins/apps/plugins/browser/plugins/shell/web";

/**
 * The proxy switch, as a row of the address pill's site-info popover. When on,
 * pages load through the same-origin framing-stripping proxy so sites that
 * refuse to be framed still render; the pill's leading glyph turns into a
 * shield while it is on.
 */
export function ProxyToggle() {
  const { enabled, toggle } = useBrowserProxy();
  return (
    <Line className="gap-sm border-t pt-sm">
      <Fill>
        <Stack gap="none">
          <Text variant="label">Load through proxy</Text>
          <Text variant="caption" tone="muted">
            For sites that refuse to be shown inside another app
          </Text>
        </Stack>
      </Fill>
      <Switch
        checked={enabled}
        onCheckedChange={() => toggle()}
        aria-label="Load through proxy"
      />
    </Line>
  );
}
