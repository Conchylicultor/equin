import { FilterChip } from "@plugins/primitives/plugins/filter-chips/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { subThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  APPS,
  CATEGORIES,
  type AppCategoryId,
  type CatalogApp,
} from "../internal/catalog";
import { equinGalleryTheme } from "../internal/theme";
import { AppCard } from "./app-card";
import "./apps-gallery.css";

export type CategoryFilter = AppCategoryId | "all";

/** An app matches when the query is in its name or what it does. */
function matchesQuery(app: CatalogApp, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || `${app.name} ${app.description}`.toLowerCase().includes(q);
}

/**
 * The gallery: a row of category chips (each with its count), then one group
 * per category — its name, its line, and a grid of app cards. The search and
 * the chip narrow the same list; a group with nothing left is not drawn, and
 * when nothing at all matches the page says so and points at the band below,
 * where a missing app gets built.
 */
export function AppsGallery({
  query,
  category,
  onCategoryChange,
}: {
  query: string;
  category: CategoryFilter;
  onCategoryChange: (category: CategoryFilter) => void;
}) {
  const hits = APPS.filter(
    (app) =>
      matchesQuery(app, query) &&
      (category === "all" || app.category === category),
  );
  const chips: { id: CategoryFilter; name: string; count: number }[] = [
    { id: "all", name: "All", count: APPS.length },
    ...CATEGORIES.map((c) => ({
      id: c.id,
      name: c.name,
      count: APPS.filter((app) => app.category === c.id).length,
    })),
  ];

  return (
    // The gallery's own sizes over the site's (`equinGalleryTheme`). Not a
    // band of its own: it sits in the page body's band with the closing block,
    // and its vertical score (the chip row's air, each group's) is the
    // gallery's, declared in `apps-gallery.css`.
    <Theme name={subThemeScope(equinGalleryTheme)} surface="none">
      <Stack
        direction="row"
        gap="xs"
        wrap
        className="website-apps-filters border-border border-b"
      >
        {chips.map((chip) => (
          <FilterChip
            key={chip.id}
            variant="outline"
            active={category === chip.id}
            onClick={() => onCategoryChange(chip.id)}
          >
            {chip.name}
            <span className="website-apps-chip-count">{chip.count}</span>
          </FilterChip>
        ))}
      </Stack>
      {hits.length === 0 ? (
        <Stack gap="xs" align="center" className="py-2xl text-center">
          <Text as="p" variant="heading">
            Nothing matches “{query.trim()}”
          </Text>
          <Text as="p" variant="body" tone="muted">
            Ask an agent to build it, just below.
          </Text>
        </Stack>
      ) : (
        CATEGORIES.map((c) => {
          const apps = hits.filter((app) => app.category === c.id);
          if (apps.length === 0) return null;
          return (
            <Stack
              as="section"
              key={c.id}
              gap="lg"
              className="website-apps-group"
            >
              <Stack direction="row" gap="sm" align="baseline" wrap>
                <Text
                  as="h3"
                  variant="heading"
                  className="font-semibold tracking-[-0.02em]"
                >
                  {c.name}
                </Text>
                <Text variant="body" tone="faint">
                  {c.body}
                </Text>
              </Stack>
              {/* Four to a row on the 1040px measure: 4 × 248px + 3 × 16px. */}
              <Grid minCellWidth="15rem" mode="fill" gap="lg">
                {apps.map((app) => (
                  <AppCard key={app.id} app={app} category={c} />
                ))}
              </Grid>
            </Stack>
          );
        })
      )}
    </Theme>
  );
}
