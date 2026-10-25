import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Website } from "@plugins/apps/plugins/website/plugins/shell/web";
import { ContactSection } from "./components/contact-section";

export default {
  description:
    "Getting in touch: the homepage's closing band — for anyone who wants to support the vision, the address in the sentence (copy on hover) and a Get in touch button that grows the card into a message form the site's server stores and emails on (sent, rate-limited and failed states said inline); for bug reports, feature requests and questions, GitHub issues.",
  contributions: [
    Website.Section({
      id: "contact",
      label: "Contact",
      component: ContactSection,
    }),
  ],
} satisfies PluginDefinition;
