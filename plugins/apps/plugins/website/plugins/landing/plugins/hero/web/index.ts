import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Website } from "@plugins/apps/plugins/website/plugins/shell/web";
import { HeroSection } from "./components/hero-section";

export default {
  description:
    "Landing hero band: the site's one headline — what equin is — with the lede under it, the showcase film (its poster and the themed player, from apps/website/media), and the three properties the claim rests on (self-evolving, integrated, personal).",
  contributions: [
    Website.Section({ id: "hero", label: "Hero", component: HeroSection }),
  ],
} satisfies PluginDefinition;
