import { WebsiteChrome } from "@plugins/apps/plugins/website/plugins/shell/web";
import { visionPane } from "../panes";
import { WebsiteVision } from "../slots";
import { VisionZoom } from "./vision-zoom";

/**
 * The vision page's body: the zoom, then every `WebsiteVision.Section`
 * contribution below it inside `WebsiteChrome`, so the site footer renders
 * exactly once. Its own chunk (`websitePagePart`), fetched only where the page
 * is shown.
 */
export function VisionBody() {
  return (
    <WebsiteChrome pane={visionPane} headerGlass>
      <VisionZoom />
      <WebsiteVision.Section.Render />
    </WebsiteChrome>
  );
}
