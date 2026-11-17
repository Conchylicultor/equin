import { useState } from "react";
import { z } from "zod";
import { keptPart } from "@plugins/primitives/plugins/kept-state/core";
import {
  defineKept,
  useKept,
} from "@plugins/primitives/plugins/kept-state/web";
import {
  WebsiteBand,
  WebsiteChrome,
  WebsiteHero,
} from "@plugins/apps/plugins/website/plugins/shell/web";
import { appsPane } from "../panes";
import { AppsSearch } from "./apps-search";
import { AppsGallery, type CategoryFilter } from "./apps-gallery";
import { AppsClosing } from "./apps-closing";

/** The gallery's search query: where the reader was looking, kept per pane. */
const appsQuery = defineKept({
  owner: "website.apps.query",
  tier: "view",
  schema: z.string(),
});

/**
 * The apps gallery's body: the heading with the search under it, then one body
 * band holding the gallery, the "Missing an app?" card and the two pages to
 * read next, inside `WebsiteChrome`. Its own chunk (`websitePagePart`),
 * fetched only where the page is shown.
 */
export function AppsBody() {
  const queryKept = useKept(appsQuery, "");
  const [query] = queryKept;
  const [category, setCategory] = useState<CategoryFilter>("all");
  const { app } = appsPane.useParams();
  return (
    <WebsiteChrome pane={appsPane}>
      <WebsiteHero
        kind="page"
        lead="The "
        accent="apps"
        lede="Every app equin ships. Each one is a composition of plugins: install it as is, or ask an agent to reshape it for you."
      >
        <AppsSearch query={keptPart(queryKept)} />
      </WebsiteHero>
      <WebsiteBand section="gallery" rhythm="page-body">
        <AppsGallery
          query={query}
          category={category}
          onCategoryChange={setCategory}
          focusedApp={app}
        />
        <AppsClosing />
      </WebsiteBand>
    </WebsiteChrome>
  );
}
