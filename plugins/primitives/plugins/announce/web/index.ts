import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { AnnouncerHost } from "./components/announcer-host";

export { announce } from "./internal/announcer-store";
export { type Announcement } from "./internal/announcer-store";

export default {
  description:
    "Screen-reader announcement primitive: a plain announce(message, { assertive }) writing into the page's two Core.Root-mounted live regions (polite status + assertive alert). Re-announcing an identical string re-fires without any timer. Degrades to a silent no-op when no host is mounted.",
  contributions: [Core.Root({ component: AnnouncerHost, scope: "page" })],
} satisfies PluginDefinition;
