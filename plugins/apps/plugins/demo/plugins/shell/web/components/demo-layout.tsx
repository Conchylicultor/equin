import { PaneOverlayHost } from "@plugins/layouts/plugins/miller/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { DemoScope } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import { AppEmbed } from "@plugins/apps-core/plugins/app-embed/web";
import { agentManagerDemo } from "@plugins/apps/plugins/agent-manager/plugins/demo/core";

const CAPTION =
  "The agent manager itself, running in this page on made-up data.";

/**
 * The demo sandbox: the real Agent Manager rendered in-process (`AppEmbed`)
 * against a browser server answering from its demo pack (`DemoScope`), in a
 * fixed frame — what the website's live-demo band will show once it ships.
 */
export function DemoLayout() {
  return (
    <Stack gap="md" className="relative h-full bg-background p-lg">
      {/* eslint-disable-next-line layout/no-adhoc-layout -- the demo's frame: the embedded app fills it */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
        <DemoScope scenario={agentManagerDemo}>
          <AppEmbed app={agentManagerDemo.app} route={agentManagerDemo.route} />
        </DemoScope>
      </div>
      <Text as="p" variant="label" tone="muted" className="text-center">
        {CAPTION}
      </Text>
      {/* Bespoke full-surface layout: mount the pane overlay so global actions
          that open panes (e.g. the theme customizer) render here. */}
      <PaneOverlayHost />
    </Stack>
  );
}
