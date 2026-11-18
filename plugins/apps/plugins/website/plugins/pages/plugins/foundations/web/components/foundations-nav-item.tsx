import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { WebsiteLearnLink } from "@plugins/apps/plugins/website/plugins/shell/web";
import { foundationsPane } from "../panes";

/**
 * "Foundations" in the shared site header's Learn menu. Opens the technical
 * foundations page.
 */
export function FoundationsNavItem() {
  const openPane = useOpenPane();
  return (
    <WebsiteLearnLink
      label="Foundations"
      gloss="The infra and harness behind the apps"
      {...openPane.link(foundationsPane, {}, { mode: "root" })}
    />
  );
}
