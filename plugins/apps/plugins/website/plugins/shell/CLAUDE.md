# shell

The site's frame: the `/about` app entry, the shared header every page wears,
and the three chrome pieces a page is built out of.

- **`WebsiteBand`** — one horizontal strip. Owns the site's ONE reading measure
  (`--website-measure`, in `website-band.css`) and the hairline between bands,
  so every band on every page lines up on the same left and right edges. A band
  that pads and centres itself will drift. Its block padding is a named `rhythm`
  (`hero` / `page-hero` / `section` / `interlude` / `closing` / `footer` /
  `page` / `page-body`) from
  the same file: the page's vertical score is a designed scale of its own, above
  what the density spacing ramp can say, so a band names its role and never
  writes a number.
- **Section reach** — how far readers get, per page. Every `WebsiteBand` takes a
  required `section` name and records `section_reach` (the deploy analytics'
  cookieless tracker) once per visit when it reaches the upper half of the
  screen, its `section` prop spelled `<page>/<section>` (`landing/layers`). The page
  comes from `WebsiteChrome` (the pane id without its `website-` prefix), so a band names only itself; a page drawing its own scene calls
  `useWebsiteSectionReach` for each part it wants counted. Read it in the Deploy
  app's Analytics tab: Events → `section_reach`, expanded by `section`. Every
  measured section is also listed in the page's full section list collect sends
  with the pageview's beacons, so the Sessions tab's "read %" counts the
  sections nobody reached too.
- **`WebsiteHero`** — the heading every page opens with: a centred sentence
  with its accent half painted through the azure→cyan gradient, the lede under
  it, and the ambient glow behind both (`website-hero.css`). `kind="home"` is
  the homepage's title page (78px). `kind="page"` is an inner page's heading:
  smaller (58px headline, 18px lede capped at 640px) through its own sub-theme,
  `equinPageHeroTheme`.
- **`WebsiteSoon`** — the one "more details soon" note a placeholder page shows
  under its heading.
- **`WebsiteChrome`** — what a pane renders instead of `PaneChrome`: the header,
  the page's bands, then the footer. Going through it is what makes "one footer
  per page" structural rather than remembered. The footer carries the wordmark, the
  email and the GitHub and Discord links; the address and the Discord invite are
  site-level facts in `core/site.ts` (the contact band's cards read the same
  ones), so neither is declared twice.
- **`WebsiteHeader`** — ONE pane-header slot, borrowed by all four panes via
  `Pane.define({ actions: WebsiteHeader })`. Declared here and only here; the
  borrowing panes must stay out of their own `slots:` records. Nav order lives in
  `config/apps/website/shell/header.jsonc` — the wordmark ahead of the spacer, the
  destinations packed against the trailing edge, in three looks only: quiet
  words for the pages, icons for what leaves the site (GitHub, Discord), and one
  pill shape for the actions (▶ Demo outlined, Wish filled).
- **Learn menu** — `WebsiteLearnMenu`, the header's "Learn ▾": the pages that
  explain equin rather than show it, contributed to `Website.LearnEntry` (each a
  `WebsiteLearnLink`: its name over a one-line gloss). A hover panel
  (`overlay/hover-popover`) in the header, plain rows of the ☰ menu on a phone.

The wordmark's full stop is the only place the brand colour appears as identity
rather than as an affordance. That is what lets a link, a button and the hero's
gradient all read as things you can act on.

**The site's theme lives here** (`web/internal/theme.ts`):

- `equinTheme` — the look: palette, chart ramp, font, and a popup's frame
  (its fill a step lighter than a card, a 10% hairline edge, a deep drop with a
  faint azure glow on dark, 14px corners). Contributed through
  `ThemeEngine.Theme` and selected for the website app by
  `config/ui/theme-engine/@app/website/theme.jsonc`. It sets no sizes, so
  everything outside the pages — the Wish panel and every other popup, the
  tab bar and rail while the site is focused — is ordinary UI at standard sizes.
- `equinDocumentTheme` — the page sizes: type scale, density, shape. A
  sub-theme (`ThemeEngine.SubTheme`), worn by every page because
  `WebsiteChrome` wraps the whole pane, header included, in it. It sets no
  colours, so the page always takes the app's.
- `equinPageHeroTheme` — an inner page's heading sizes, worn by
  `WebsiteHero kind="page"` over the document's. A page region that reads in
  other sizes (the Apps gallery) declares its own sub-theme the same way, in its
  own plugin.

A size a page needs goes in a sub-theme; a colour goes in the theme. Two
values in the density fragment are the header's: `chromePaneH` is the 72px site header, and
`chromePadX` is a gutter computed from `--website-measure`, which is how the pane
header's wordmark and nav land on the same edges as every band in the body (the
pane header's own insets derive from it and are re-derived inside the
sub-theme). The
site's filled control is the foreground inverted (a white pill with dark type),
carried by `secondary`; `primary` is the azure accent and stays for identity and
hover.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: App shell for the Website (equin public site). Registers the /about app entry, owns the shared site header (wordmark, the Learn menu over the Website.LearnEntry slot, the GitHub and Discord links) and the band/page/footer chrome every page wears, defines the Website.Section landing slot, the Website.Layer slot for what floats over every page and the Website.Resident slot for what must outlive a page switch (both rendered by the app's surface) and the Website.FooterLink slot for the footer's small print (beside the address and the GitHub and Discord links), and contributes the site's own theme (equin: palette, chart ramp, font), which the website app selects, plus the equin-document sub-theme (type scale, density, shape) every page wears and the equin-page-hero sub-theme an inner page's heading wears. The website's landing page on the server: its sitemap entry (WebsitePages.Page).
- Web:
  - Slots:
    - `Website.Section`
    - `Website.Layer`
    - `Website.Resident`
    - `Website.LearnEntry`
    - `Website.FooterLink`
    - `WebsiteHeader`
  - Slot contributors:
    - `Website.Section` ← `apps.website.landing.contact`
    - `Website.Section` ← `apps.website.landing.hero`
    - `Website.Section` ← `apps.website.landing.layers`
    - `Website.Section` ← `apps.website.landing.screenshot`
    - `Website.Section` ← `apps.website.landing.story-link`
    - `Website.Layer` ← `apps.website.pages.privacy`
    - `Website.Resident` ← `apps.website.live-demo`
    - `Website.LearnEntry` ← `apps.website.pages.foundations`
    - `Website.LearnEntry` ← `apps.website.pages.story`
    - `Website.FooterLink` ← `apps.website.pages.privacy`
    - `WebsiteHeader` ← `apps.website.improve`
    - `WebsiteHeader` ← `apps.website.pages.apps`
    - `WebsiteHeader` ← `apps.website.pages.download`
    - `WebsiteHeader` ← `apps.website.pages.guide`
    - `WebsiteHeader` ← `apps.website.pages.vision`
    - `WebsiteHeader` ← `apps.website.shell`
    - `WebsiteHeader` ← `primitives.pane`
  - Contributes:
    - `Apps.App` "equin" → `WebsiteLayout`
    - `WebsiteHeader` "wordmark" → `WebsiteWordmark`
    - `WebsiteHeader` "learn" → `WebsiteLearnMenu`
    - `WebsiteHeader` "github" → `WebsiteGithubLink`
    - `WebsiteHeader` "discord" → `WebsiteDiscordLink`
    - `Pane.Register` "website-landing"
    - `ThemeEngine.Theme` "equin"
    - `ThemeEngine.SubTheme` "equin document"
    - `ThemeEngine.SubTheme` "equin page heading"
  - Uses: 38 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/pane` ×7
    - `primitives/action-presentation` ×3
    - `primitives/css/spacing` ×3
    - `apps/deploy/analytics/collect` ×2
    - `primitives/css/text` ×2
    - `primitives/css/ui-kit` ×2
    - `primitives/overlay/hover-popover` ×2
    - `primitives/slot-render` ×2
    - `apps-core.Apps`
    - `layouts/full-pane.FullPane`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/coords.Placed`
    - `primitives/css/fill.Fill`
    - `primitives/css/inline.Inline`
    - `primitives/css/row.Row`
    - `primitives/css/theme-boundary.Theme`
    - `primitives/dom/auto-scroll.findScrollParent`
    - `primitives/dom/scroll-reveal.revealElement`
    - `primitives/icon-button.IconButton`
    - `primitives/lazy-component.lazyComponent`
    - `primitives/overlay/surface-overlay.SurfaceOverlay`
    - `ui/icons.Icon`
    - `ui/theme-engine.ThemeEngine`
  - Exports (types): `WebsiteBandRhythm`
  - Exports (values):
    - `landingPane`
    - `useWebsiteSectionReach`
    - `Website`
    - `WebsiteArrow`
    - `WebsiteBand`
    - `WebsiteChrome`
    - `WebsiteFooterLink`
    - `WebsiteHeader`
    - `WebsiteHero`
    - `WebsiteLearnLink`
    - `WebsiteNavLead`
    - `WebsiteNavLink`
    - `websitePagePart`
    - `WebsiteScrollCue`
    - `WebsiteSoon`
- Server:
  - Contributes: `apps.website.crawlable.page` "/about"
  - Uses: `apps/website/crawlable.WebsitePages`
- Core:
  - Uses:
    - `apps/website/crawlable.defineWebsitePage`
    - `apps/website/crawlable.WEBSITE_BASE_PATH`
    - `framework/product-name.SOURCE_REPO`
    - `framework/product-name.SOURCE_REPO_URL`
    - `infra/launcher/gateway-port.pagePort`
    - `infra/namespace.GATEWAY_PORT_RANGE`
    - `infra/namespace.isGatewayPort`
    - `infra/namespace.LEGACY_GATEWAY_PORT`
    - `infra/namespace.MAIN_WORKTREE_NAME`
    - `infra/namespace.namespaceFromHost`
    - `infra/namespace.namespaceHost`
    - `infra/namespace.namespaceUrl`
    - `primitives/pane.defineApp`
    - `primitives/pane/route-prefix.addressPathOf`
    - `primitives/pane/route-prefix.routePathOf`
    - `ui/icons.symbol`
  - Exports (values):
    - `CONTACT_EMAIL`
    - `CONTACT_MAILTO`
    - `DISCORD_URL`
    - `INSTALL_COMMAND`
    - `isLocalAppUrl`
    - `isPublicSiteUrl`
    - `ISSUES_URL`
    - `landingPage`
    - `localAppHost`
    - `localAppPortFor`
    - `localAppUrl`
    - `localSiteUrl`
    - `PUBLIC_SITE_ORIGIN`
    - `publicSitePageUrl`
    - `publicSiteUrl`
    - `websiteApp`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/chart --chart-1`
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --faint-foreground`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --popover`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --primary-foreground`
    - `ui/tokens/color-palette --primary-text`
    - `ui/tokens/density --chrome-pad-x`
    - `ui/tokens/density --control-height-sm`
    - `ui/tokens/density --control-pad-sm`
    - `ui/tokens/density --space-2xl`
    - `ui/tokens/shadow --shadow-popover`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-bold`
    - `ui/tokens/type-scale --font-weight-normal`
    - `ui/tokens/type-scale --font-weight-semibold`
  - Imported by: 21 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×19
    - `companions/browser-extension/equin-site`
    - `hints/help-menu`

<!-- AUTOGENERATED:END -->
