import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { WebsiteFooterLink } from "@plugins/apps/plugins/website/plugins/shell/web";
import { privacyPane } from "../panes";

/** "Privacy" in the footer's small print. Opens the privacy page. */
export function PrivacyFooterLink() {
  const openPane = useOpenPane();
  return (
    <WebsiteFooterLink
      label="Privacy"
      {...openPane.link(privacyPane, {}, { mode: "root" })}
    />
  );
}
