import { useState } from "react";
import { WebsiteChrome } from "@plugins/apps/plugins/website/plugins/shell/web";
import { foundationsPane } from "../panes";
import type { HeaderOver } from "../internal/iceberg/scene";
import {
  icebergSeaHeaderTheme,
  icebergSkyHeaderTheme,
} from "../internal/theme";
import { IcebergSection } from "./iceberg-section";

/**
 * The foundations page's body: the iceberg inside `WebsiteChrome`, the header
 * dressed for what is under it — the sky's ink over the sky, light ink on
 * black water. Its own chunk (`websitePagePart`), fetched only where the page
 * is shown.
 */
export function FoundationsBody() {
  const [headerOver, setHeaderOver] = useState<HeaderOver>("sky");
  return (
    <WebsiteChrome
      pane={foundationsPane}
      headerTheme={
        headerOver === "sky" ? icebergSkyHeaderTheme : icebergSeaHeaderTheme
      }
      headerGlass
    >
      <IcebergSection onHeaderOver={setHeaderOver} />
    </WebsiteChrome>
  );
}
