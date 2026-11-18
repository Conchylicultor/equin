import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { WebsiteNavLink } from "@plugins/apps/plugins/website/plugins/shell/web";
import { GUIDE_READY } from "../../core";
import { guidePane } from "../panes";

/**
 * "Guide" entry in the shared site header. Opens the getting-started guide.
 */
export function GuideNavItem() {
  const openPane = useOpenPane();
  if (!GUIDE_READY) return null;
  return (
    <WebsiteNavLink
      label="Guide"
      {...openPane.link(guidePane, {}, { mode: "root" })}
    />
  );
}
