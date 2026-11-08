import { PaneOverlayHost } from "@plugins/layouts/plugins/miller/web";
import { Bar } from "@plugins/primitives/plugins/bar/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  DemoScope,
  useDemoHostControl,
} from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useConfirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import { AppEmbed } from "@plugins/apps-core/plugins/app-embed/web";
import { workspaceDemo } from "@plugins/apps/plugins/website/plugins/demos/plugins/workspace/core";
import { useIsPhone } from "../hooks/use-is-phone";

const PHONE_NOTICE = "Apps are only available on desktop, not mobile.";

const CAPTION =
  "The agent manager itself, running in this page on made-up data.";

/**
 * The demo sandbox: the real Agent Manager rendered in-process (`AppEmbed`)
 * against the demo's browser server (`DemoScope`), in a fixed frame — what the
 * website's live-demo band will show once it ships. The demo's data is kept in
 * this browser; the caption bar's Reset demo brings the story back.
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
      <DemoScope scenario={workspaceDemo}>
        <Bar>
          <Text as="p" variant="label" tone="muted">
            {CAPTION}
          </Text>
          <ResetDemoButton />
        </Bar>
        {/* eslint-disable-next-line layout/no-adhoc-layout -- the demo's padded frame region: fills the space under the caption bar */}
        <div className="flex min-h-0 flex-1 flex-col p-lg">
          {/* eslint-disable-next-line layout/no-adhoc-layout -- the demo's frame: the embedded app fills it */}
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
            {/* The embed is all this page shows: its shortcuts answer at once. */}
            <AppEmbed
              app={workspaceDemo.app}
              route={workspaceDemo.route}
              fillsPage
            />
          </div>
        </div>
      </DemoScope>
      {/* Bespoke full-surface layout: mount the pane overlay so global actions
          that open panes (e.g. the theme customizer) render here. */}
      <PaneOverlayHost />
    </Stack>
  );
}

/**
 * Reset: the demo keeps what the visitor does (in this browser, across reloads
 * and tabs) until they ask for the story back — every open tab of the demo
 * starts again from it.
 */
function ResetDemoButton() {
  const confirmDialog = useConfirmDialog();
  const { reset } = useDemoHostControl();
  return (
    <Button
      variant="outline"
      onClick={() => {
        void confirmDialog({
          title: "Reset the demo?",
          description:
            "Everything you changed in the demo is erased, and it starts again from its story — in every tab it is open in.",
          confirmLabel: "Reset demo",
          onConfirm: () => reset(),
        });
      }}
    >
      Reset demo
    </Button>
  );
}
