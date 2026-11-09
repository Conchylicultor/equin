import { FullPane } from "@plugins/layouts/plugins/full-pane/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { DemoScope } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import { demoScenario } from "../../core";
import { useIsPhone } from "../hooks/use-is-phone";

const PHONE_NOTICE = "Apps are only available on desktop, not mobile.";

/**
 * The demo sandbox's surface: the demo's browser server (`DemoScope` — the
 * workspace scenario's host: real server code in a worker, on the demo's
 * data kept in this browser) around the full-pane renderer, so the demo's
 * one screen (`demo-at`: the demo at the location the URL names, framed or
 * full screen) renders against it. The scope sits above the pane: settling
 * `/demo` on its start location never restarts the host.
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
    <DemoScope scenario={demoScenario}>
      <FullPane />
    </DemoScope>
  );
}
