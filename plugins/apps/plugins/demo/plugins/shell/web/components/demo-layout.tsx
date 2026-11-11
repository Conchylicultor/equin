import { FullPane } from "@plugins/layouts/plugins/full-pane/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useIsPhone } from "../hooks/use-is-phone";

const PHONE_NOTICE = "Apps are only available on desktop, not mobile.";

/**
 * The demo sandbox's surface: the full-pane renderer over its one screen
 * (`demo-page`: the demo's browser server around the embed, framed or
 * maximized). On a phone it renders a notice instead: `DemoScope` never mounts, so its
 * worker (PGlite and the server bundle, ~20 MB) is never fetched.
 */
export function DemoLayout() {
  const isPhone = useIsPhone();
  // No screen to ask yet (a static render): what to mount is not known.
  if (isPhone === null) return <Loading />;
  if (isPhone) {
    return (
      <Center className="h-full bg-background p-lg">
        <Text as="p" variant="label" tone="muted">
          {PHONE_NOTICE}
        </Text>
      </Center>
    );
  }
  return <FullPane />;
}
