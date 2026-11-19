import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { WishSlots } from "@plugins/wish/web";
import { FileOnGithubButton } from "./components/file-on-github-button";

export default {
  description:
    "File on GitHub: a button in the Wish popover's footer, beside Launch, that opens GitHub's new-issue form on the product's repository prefilled with the drafted wish, the page it is about and the environment (equin version — release, commit, commits ahead of / behind the trunk — system and browser), then clears the draft.",
  contributions: [
    WishSlots.FooterAction({
      id: "github-issue",
      component: FileOnGithubButton,
    }),
  ],
} satisfies PluginDefinition;
