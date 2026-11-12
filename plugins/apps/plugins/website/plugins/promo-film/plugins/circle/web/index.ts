import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { circleApp } from "../core";
import { CircleLayout } from "./components/circle-layout";

export default {
  description:
    "Circle, the film's 'implemented' P2P messaging app: registers the /circle app entry, whose one page is the Circle prototype it was built from, full surface, in its light theme.",
  contributions: [Apps.App({ app: circleApp, component: CircleLayout })],
} satisfies PluginDefinition;
