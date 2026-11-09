import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Logo } from "./components/logo";
export type { LogoProps } from "./components/logo";

export default {
  description:
    "<Logo className tone>: the equin logo, drawn from ui/logo's geometry — its small master below 28 px (a container query on its own box), in the brand gradient or the text colour.",
} satisfies PluginDefinition;
