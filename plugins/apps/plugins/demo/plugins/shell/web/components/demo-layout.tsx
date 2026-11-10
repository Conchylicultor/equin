import { FullPane } from "@plugins/layouts/plugins/full-pane/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { DemoScope } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import { DEMO_FULL, demoScenario } from "../../core";
import { DemoBootScreen } from "@plugins/apps/plugins/demo/plugins/chrome/web";
import { useIsPhone } from "../hooks/use-is-phone";
import { DemoFrame, demoAtPane } from "./demo-at";

const PHONE_NOTICE = "Apps are only available on desktop, not mobile.";

/**
 * The demo sandbox's surface: the demo's browser server (`DemoScope` — the
 * workspace scenario's host: real server code in a worker, on the demo's
 * data kept in this browser) around the full-pane renderer, so the demo's
 * one screen (`demo-at`: the demo at the location the URL names, framed or
 * maximized) renders against it. The scope sits above the pane: settling
 * `/demo` on its start location never restarts the host.
 *
 * The boot screen is drawn where the demo will be: in the framed page, or —
 * the URL maximized (`;full=1`: a reload, a new tab from inside) — as the
 * whole page, so Enter opens the demo in place, as maximized as it says.
 *
 * On a phone it renders a notice instead: `DemoScope` never mounts, so its
 * worker (PGlite and the server bundle, ~20 MB) is never fetched.
 */
export function DemoLayout() {
  const isPhone = useIsPhone();
  const full = demoAtPane.useRouteEntry()?.params.full === DEMO_FULL;
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
    <DemoScope
      scenario={demoScenario}
      // Until the demo runs: its boot screen where the demo will show —
      // framed under the caption bar, or maximized as the whole page.
      boot={(state) => (
        <DemoFrame full={full}>
          <DemoBootScreen state={state} />
        </DemoFrame>
      )}
    >
      <FullPane />
    </DemoScope>
  );
}
