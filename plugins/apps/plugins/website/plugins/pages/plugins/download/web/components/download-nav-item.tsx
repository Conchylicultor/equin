import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { useAppLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { demoPagePath } from "@plugins/apps/plugins/website/plugins/live-demo/core";
import {
  WebsiteNavLink,
  WebsiteNavPill,
} from "@plugins/apps/plugins/website/plugins/shell/web";
import { track } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { downloadPane } from "../panes";

const playIcon = symbol("play-arrow");

/** The demo page at its own start, as the download page's closing card opens it. */
const DEMO_URL = demoPagePath(undefined);

/**
 * The header's way in, for a reader ready to run equin: one pill split into
 * ▶ Demo (the real app in this browser, on made-up data) and Download (the
 * install page). One choice made two ways, so one object — and the header gains
 * the demo without gaining another page link.
 */
export function DownloadNavItem() {
  const openPane = useOpenPane();
  const appLinkProps = useAppLinkProps();
  return (
    <WebsiteNavPill label="Try or install equin">
      <WebsiteNavLink
        emphasis="segment"
        label="Demo"
        // A small filled triangle in the brand blue: the one mark of colour in
        // the pill, sized to the label rather than to a 16px glyph box, whose
        // own margin read as a gap before the word. 12px: the Material glyph
        // fills less of its box than a drawn triangle, so this is what draws
        // the mock's ~6×7 mark.
        icon={
          <Icon icon={playIcon} active className="text-primary-text size-3" />
        }
        {...appLinkProps(DEMO_URL)}
        onClickCapture={() => track("header_demo")}
      />
      <WebsiteNavLink
        emphasis="segment"
        label="Download"
        {...openPane.link(downloadPane, {}, { mode: "root" })}
      />
    </WebsiteNavPill>
  );
}
