import { useState } from "react";
import {
  WebsiteBand,
  WebsiteChrome,
  WebsiteHero,
} from "@plugins/apps/plugins/website/plugins/shell/web";
import { appsPane } from "../panes";
import { AppsSearch } from "./apps-search";
import { AppsGallery, type CategoryFilter } from "./apps-gallery";
import { AppsClosing } from "./apps-closing";

/**
 * The apps gallery's body: the heading with the search under it, then one body
 * band holding the gallery, the "Missing an app?" card and the two pages to
 * read next, inside `WebsiteChrome`. Its own chunk (`websitePagePart`),
 * fetched only where the page is shown.
 */
export function AppsBody() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  return (
    <WebsiteChrome pane={appsPane}>
      <WebsiteHero
        kind="page"
        lead="The "
        accent="apps"
        lede="Every app equin ships. Each one is a composition of plugins: install it as is, or ask an agent to reshape it for you."
      >
        <AppsSearch query={query} onQueryChange={setQuery} />
      </WebsiteHero>
      <WebsiteBand section="gallery" rhythm="page-body">
        <AppsGallery
          query={query}
          category={category}
          onCategoryChange={setCategory}
        />
        <AppsClosing />
      </WebsiteBand>
    </WebsiteChrome>
  );
}
