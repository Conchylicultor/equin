import { prototypeDocument } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  ContentFrame,
  useContentUrl,
} from "@plugins/primitives/plugins/embed/plugins/frame/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { CIRCLE_PROTOTYPE, circleApp } from "../../core";

/** The prototype's picks the app ships with: online, the light theme. */
const PICKS = { network: "online", theme: "light" };

/** The whole app is its prototype, framed full surface. */
export function CircleLayout() {
  const url = useContentUrl(
    prototypeDocument(CIRCLE_PROTOTYPE, { picks: PICKS }),
  );
  return url.kind === "ready" ? (
    <ContentFrame
      title={circleApp.name}
      src={url}
      className="h-full w-full border-0"
    />
  ) : (
    <Center className="h-full w-full">
      <Text variant="caption" tone="muted">
        {url.message}
      </Text>
    </Center>
  );
}
