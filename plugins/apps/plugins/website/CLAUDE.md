# website

The public equin site: a homepage that makes one claim — a personal OS that
evolves on request — shows it, maps the project in three layers, and offers a
way to write.

It is not a product page — there is nothing to download and nothing to install.
One developer's open-source proof of concept, so the homepage's job is to state
the claim, show what it looks like, and then get out of the way:

- [`landing`](plugins/landing/CLAUDE.md) — the homepage's bands: the hero, the
  screenshot, the layers, the story link, the contact block.
- [`demos`](plugins/demos/CLAUDE.md) — the live demos, one plugin each, each owning
  its data and writing it into its own browser host through the apps' fixture
  writers (`demos/workspace`: the Agent Manager, Pages, Prototypes, Sonata and Keyboard Party on Demo's own equin).
- [`live-demo`](plugins/live-demo/CLAUDE.md) — the live demo's runtime: its
  server kept for the visit by a `Website.Resident`, drawn in the homepage's
  frame or alone on the demo page (`/about/demo`).
- [`pages`](plugins/pages/CLAUDE.md) — the inner pages: the apps gallery
  (`/about/apps`), the download page, the foundations iceberg
  (`/about/foundations`), and the vision, story and guide pages
  (`/about/vision`, …), each with its own section slot the page gets written
  into — placeholders for now.
- [`media`](plugins/media/CLAUDE.md) — the site's binary media (the showcase
  film and its poster), never in git: assets of the `website-media` GitHub
  release, served through the asset mirror and bundled into a release.
- [`improve`](plugins/improve/CLAUDE.md) — the header's Wish button: the
  visitor describes a change, watches a scripted replay of what an agent would
  do with it, and can file it as a prefilled GitHub issue. No agent runs here.
- [`shell`](plugins/shell/CLAUDE.md) — the app entry, the shared site header
  every page wears, and the band / heading / page / footer chrome
  (`WebsiteBand`, `WebsiteHero`, `WebsiteChrome`).

**Two addresses, one route.** On the desktop the site is the website app at
`/about` (`/about/vision`), beside every other app. The public site — the
`website` composition, `homeAtRoot: true` — serves it at `/`
(`equin.ai/vision`), and `equin.ai/about/…` answers with a 301. Code always
writes route paths (`/about/…`: page declarations, `pane.link`, analytics);
the address is derived at the boundary (`primitives/pane/route-prefix`'s
address root). A public URL in code goes through `publicSitePageUrl` /
`publicSiteUrl` (`shell/core/site.ts`), never a hand-written
`https://equin.ai/about/…`.

## The rules that are easy to break

**Reading order is authored, not inherited.** A page's band order lives in
`config/apps/website/shell/section.jsonc` (and the nav's in `header.jsonc`) —
committed, commented, and the thing to edit when a band moves. It is NOT the
plugin load order, which is a function of who imports whom and has no opinion
about which paragraph comes first.

**The site's design is its theme, not its components.** The site paints one
designed theme, `equin` (palette, chart ramp, type scale, density, shape,
font), declared in the shell (`plugins/shell/web/internal/theme.ts`) and
selected for the website app by one file,
`config/ui/theme-engine/@app/website/theme.jsonc`. That selection is the whole
per-app theme: a group equin leaves out paints its schema defaults, never the
desktop's runtime choice, so there is nothing else to pin. Every component reads
semantic tokens and type roles; the bespoke paint (the heading's wash and
gradient, the drawn desktop screenshot, the cards' lift) is mixed from theme
tokens too. Never hardcode a colour in a website component. The one scale the
token groups cannot carry is the page's vertical rhythm (112px over the
headline, 72px around a section — far above the density ramp's 2rem ceiling), which
`WebsiteBand` takes as a named `rhythm` declared in the shell's
`website-band.css`.

The one palette the theme does not carry is the Foundations page's iceberg
(`pages/foundations`): a drawing whose sunlit sky and black abyss are the
picture itself, the same in either mode. It declares its palette once, scoped to
the scene, and documents why there; it is not a precedent for a component's
colour. The Vision page's zoom (`pages/vision`) is the second such picture —
a night sky whose drawings glow in their own blues — declared and documented
the same way.

Light/dark is still global — per-scope dark hasn't landed — so the site follows
the desktop's mode; the dark values are the design and the light ones a readable
inversion of it.

**Every page goes through `WebsiteChrome` and every band through
`WebsiteBand`.** That is what makes "one footer per page" and "one reading
measure across the site" true by construction instead of by remembering.

**Record an event for every meaningful visitor action**: `track("<surface>_<action>", props?)`
(`apps/deploy/analytics/collect`) on what the owner would want counted (play,
Enter, Maximize, open, CTA, submit), never on noise (hover, close, toggles,
inside the demo). Variants are props; never visitor text. Names are lowercase
letters, digits and `_` only (`track` throws). Record where the action
succeeds (`onPlay`, not the click), once per action.

Copy register: plain and warm, the way you'd describe it to a friend. Simple
words, a little personality, never forced: no slogans or catchy wordplay, no
feature lists or jargon. Sounds like an ad or a spec → rewrite. The word is **equin**
everywhere a reader can see it; the old name survives only as an internal identifier (the repository, the namespace, the data dir).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Website — the public-facing site of equin: the homepage's claim, a picture of it and the three layers of the project, a gallery of its apps, placeholder pages for the vision, the foundations and the story, and how to get in touch.
- Sub-plugins:
  - **`app-tiles`** — The website's app tile: <WebsiteAppTile symbol color />, an app's glyph on its vivid website colour as a diagonal gradient on a bounded squircle.
  - **`crawlable`** [1 sub-plugin] — The website's pages on the server: the WebsitePages.Page collection every page plugin contributes its defineWebsitePage declaration to, and the public /robots.txt (allow all, pointing at the…
  - **`demos`** [test helpers] [2 sub-plugins] — The website's live demos, one plugin each: a demo owns its story and its data (pages, prototypes, agent runs) and writes them into its own browser host through each app's fixture writer.
  - **`improve`** — The website's Wish button: the header's call to action, a popover where a visitor describes a change to the page, watches a scripted replay of what equin would do with it, and files it as a…
  - **`landing`** [6 sub-plugins] — Landing-page bands of the public website: the hero, the live demo, the three layers of equin, the story link, and the contact block.
  - **`live-demo`** — The website's live demo runtime: equin itself, its real server code in a worker on the workspace demo's data (DemoScope around AppEmbed), kept for the whole visit by a Website.Resident in the site's…
  - **`media`** — The website's media (the showcase film and its poster), kept out of git: assets of the website-media GitHub release, pinned by sha256 and served same-origin through the asset mirror and bundled into…
  - **`pages`** [11 sub-plugins] — The inner pages of the public website: the apps gallery, the vision for applications, the technical foundations, the story of how equin came to be, the getting-started guide, and how to install it.
  - **`promo-film`** [2 sub-plugins] — The equin showcase film (script: the Video page's Script v2): the real app recorded as one continuous session on the seeded promo-film composition (e2e/record.ts), ending on equin's desktop mode…
  - **`readme`** — The repo README's images: the animated hero (the logo drawing itself in, beside a living plugin network), the link pills (Watch the film, Try the demo, Install, Discord), the app shelf and the Try…
  - **`shell`** — App shell for the Website (equin public site). Registers the /about app entry, owns the shared site header (wordmark, the Learn menu over the Website.LearnEntry slot, the GitHub and Discord links)…

<!-- AUTOGENERATED:END -->
