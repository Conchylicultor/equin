import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export default {
  description:
    "The Lumen demo — the website's live demo of the Agent Manager, Pages and Prototypes on one made-up story (core: lumenDemo — the app, the route /c/conv-demo-dark-mode and its browser host: real server code in a Web Worker on PGlite, seeded with the demo's own data through each app's fixture writer — a queue of agents, one conversation fixing a bug, the Lumen pages and prototypes, every id carrying `demo`) and its exhibit, the app rendered in-process on that host.",
} satisfies PluginDefinition;
