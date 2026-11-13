import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Website } from "@plugins/apps/plugins/website/plugins/shell/web";
import { privacyPane } from "./panes";
import { ConsentPrompt } from "./components/consent-prompt";
import { PrivacyFooterLink } from "./components/privacy-footer-link";

export { privacyPane } from "./panes";

export default {
  description:
    "The privacy page of the equin website and the consent prompt that links to it: the /about/privacy pane (this browser's choice, what a visit records, the two ways a return is recognised — a random key kept in the browser when the visitor accepts, else the daily hash — and how long it is kept), its Privacy link in the footer, and the prompt floating over every page (Website.Layer) until the browser answers Reject or Accept.",
  contributions: [
    // This pane BORROWS the shared site header (`actions: WebsiteHeader`), so it
    // mints no slot of its own — the header is declared once, by
    // `apps.website.shell`. It puts no link in it: Privacy is small print.
    Pane.Register({ pane: privacyPane }),
    Website.Layer({
      id: "consent",
      label: "Consent prompt",
      component: ConsentPrompt,
    }),
    Website.FooterLink({
      id: "privacy",
      label: "Privacy",
      component: PrivacyFooterLink,
    }),
  ],
} satisfies PluginDefinition;
