import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import {
  WebsiteChrome,
  WebsiteHeader,
} from "@plugins/apps/plugins/website/plugins/shell/web";
import { useState } from "react";
import { IcebergSection } from "./components/iceberg-section";
import type { HeaderOver } from "./internal/iceberg/scene";
import { icebergSeaHeaderTheme, icebergSkyHeaderTheme } from "./internal/theme";

/**
 * The foundations page at `/website/foundations` — what equin brings on top
 * of Claude, drawn as an iceberg. Wears the shared site header
 * (`actions: WebsiteHeader`) inside `WebsiteChrome`, so the site footer renders
 * exactly once. The header stays pinned and frosts once the page moves, dressed
 * for what is under it: the sky's ink over the sky, light ink on black water.
 */
export const foundationsPane = Pane.define({
  route: defineRoute({ id: "website-foundations", segment: "foundations" }),
  app: websiteApp,
  actions: WebsiteHeader,
  component: FoundationsBody,
});

function FoundationsBody() {
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
