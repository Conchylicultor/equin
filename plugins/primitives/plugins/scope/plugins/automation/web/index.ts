import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { AUTOMATED_BROWSER } from "./internal/automated";

export default {
  description:
    "Whether this page is driven by automation (AUTOMATED_BROWSER: navigator.webdriver — Playwright, an e2e run, the agent browser): the one definition every beacon marks its signals with, so a report names who saw it instead of muting it.",
  contributions: [],
} satisfies PluginDefinition;
