import { PaneOverlayHost } from "@plugins/layouts/plugins/miller/web";
import { Bar } from "@plugins/primitives/plugins/bar/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { DemoScope } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import { AppEmbed } from "@plugins/apps-core/plugins/app-embed/web";
import { agentManagerDemo } from "@plugins/apps/plugins/agent-manager/plugins/demo/core";
import { useIsPhone } from "../hooks/use-is-phone";

const PHONE_NOTICE = "Apps are only available on desktop, not mobile.";

const CAPTION =
  "The agent manager itself, running in this page on made-up data.";

/**
 * The demo sandbox: the real Agent Manager rendered in-process (`AppEmbed`)
 * against a browser server answering from its demo pack (`DemoScope`), in a
 * fixed frame — what the website's live-demo band will show once it ships.
 *
 * The caption is the page's own top bar: it is the surface's top-right corner,
 * so it reserves the global floating action bar's room and anchors it — the
 * embed is a `floating-bar-boundary`, so the bar never rides its headers.
 *
 * On a phone it renders a notice instead: `DemoScope` never mounts, so its
 * worker (PGlite and the server bundle, ~20 MB) is never fetched.
 */
export function DemoLayout() {
  const isPhone = useIsPhone();
  if (isPhone) {
    return (
      <Center className="h-full bg-background p-lg">
        <Text as="p" variant="label" tone="muted">
          {PHONE_NOTICE}
        </Text>
      </Center>
    );
  }
  return (
    <Stack gap="none" className="relative h-full bg-background">
      <Bar>
        <Text as="p" variant="label" tone="muted">
          {CAPTION}
        </Text>
      </Bar>
      {/* eslint-disable-next-line layout/no-adhoc-layout -- the demo's padded frame region: fills the space under the caption bar */}
      <div className="flex min-h-0 flex-1 flex-col p-lg">
        {/* eslint-disable-next-line layout/no-adhoc-layout -- the demo's frame: the embedded app fills it */}
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
          <DemoScope scenario={agentManagerDemo}>
            <AppEmbed
              app={agentManagerDemo.app}
              route={agentManagerDemo.route}
            />
          </DemoScope>
        </div>
      </div>
      {/* Bespoke full-surface layout: mount the pane overlay so global actions
          that open panes (e.g. the theme customizer) render here. */}
      <PaneOverlayHost />
    </Stack>
  );
}
