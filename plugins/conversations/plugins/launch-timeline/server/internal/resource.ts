import { serveCollection } from "@plugins/network/plugins/live/server";
import { conversationLaunches } from "../../core";
import { launches } from "./tables";

// The newest launches, a window ordered by request time.
export const conversationLaunchesServed = serveCollection(
  conversationLaunches,
  { from: launches },
);
