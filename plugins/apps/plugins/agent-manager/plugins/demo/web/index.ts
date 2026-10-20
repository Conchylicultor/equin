import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export default {
  description:
    "The Agent Manager's demo scenario (core: agentManagerDemo — the app, the route /c/conv-demo-dark-mode and its browser host: real server code in a Web Worker on PGlite, seeded with a queue of agents and one conversation fixing a bug, every id carrying `demo`) and its exhibit, the app rendered in-process on that host.",
} satisfies PluginDefinition;
