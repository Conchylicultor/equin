import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";

import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { websiteApp } from "../core";
import { WebsiteLayout } from "./components/website-layout";
import { WebsiteWordmark } from "./components/website-wordmark";
import { WebsiteGithubLink } from "./components/website-github-link";
import { WebsiteHeader, Website } from "./slots";
import { landingPane } from "./panes";
import {
  equinDocumentTheme,
  equinPageHeroTheme,
  equinTheme,
} from "./internal/theme";

export { Website, WebsiteHeader } from "./slots";
export { WebsiteNavLink } from "./components/website-nav-link";
export { WebsiteArrow } from "./components/website-arrow";
export { WebsiteBand } from "./components/website-band";
export { WebsiteHero } from "./components/website-hero";
export { WebsiteSoon } from "./components/website-soon";
export type { WebsiteBandRhythm } from "./components/website-band";
export { WebsiteChrome } from "./components/website-chrome";
export { landingPane } from "./panes";

export default {
  description:
    "App shell for the Website (equin public site). Registers the /website app entry, owns the shared site header (wordmark + nav) and the band/page/footer chrome every page wears, defines the Website.Section landing slot, and contributes the site's own theme (equin: palette, chart ramp, font), which the website app selects, plus the equin-document sub-theme (type scale, density, shape) every page wears and the equin-page-hero sub-theme an inner page's heading wears.",
  contributions: [
    Apps.App({
      app: websiteApp,
      component: WebsiteLayout,
    }),
    WebsiteHeader({ id: "wordmark", component: WebsiteWordmark }),
    // The source link, beside the pages — see `config/apps/website/shell/header.jsonc`.
    WebsiteHeader({ id: "github", component: WebsiteGithubLink }),
    Pane.Register({ pane: landingPane }),
    // The site's theme, selected for the website app in
    // `config/ui/theme-engine/@app/website/theme.jsonc`. Contributed by the
    // shell because the shell is the site's frame: its colour is its theme, not
    // its components.
    ThemeEngine.Theme(equinTheme),
    // The page sizes every page wears inside `WebsiteChrome`, over the site's
    // theme.
    ThemeEngine.SubTheme(equinDocumentTheme),
    // An inner page's heading sizes, worn by `WebsiteHero kind="page"` over
    // the document's.
    ThemeEngine.SubTheme(equinPageHeroTheme),
  ],
  // `header` declares the SHARED site header, which all four pages borrow — so
  // none of them appears in its own plugin's `slots:` record, and the landing
  // pane is not declared here either. Declaring one slot under two names is what
  // the declaration pass rejects.
  slots: { ...Website, header: WebsiteHeader },
} satisfies PluginDefinition;
