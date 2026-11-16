import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { useAppLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { AppIconTile } from "@plugins/apps-core/plugins/app-icon/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { track } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import {
  APPS,
  appsPane,
  catalogAppIcon,
  tryLivePath,
  type CatalogApp,
} from "@plugins/apps/plugins/website/plugins/pages/plugins/apps/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

/** The apps the shelf shows as pictures, in order: each one the live demo carries. */
const FEATURED_IDS = ["agents", "pages", "sonata", "maps"] as const;

const playIcon = symbol("play-arrow");
const arrowForwardIcon = symbol("arrow-forward");

function catalogApp(id: string): CatalogApp {
  const app = APPS.find((a) => a.id === id);
  if (app === undefined) throw new Error(`apps shelf: no catalog app "${id}"`);
  return app;
}

/**
 * The applications layer's shelf: four apps as pictures to try live, then
 * every other app as a tile, and "All N apps".
 *
 * The apps are the gallery's catalog (`pages/apps`), so the homepage and the
 * gallery cannot list different apps; each tile is the gallery's own
 * (`AppIconTile`: its glyph on its colour, the tile the app itself draws).
 *
 * Every entry is a link of its own, above the layer's full-bleed link: a
 * picture and a tile open the app's card in the gallery (the picture's "Try
 * it live" the live demo on that app), "All N apps" the gallery.
 */
export function AppsShelf() {
  const featured = FEATURED_IDS.map(catalogApp);
  const rest = APPS.filter((app) => !featured.includes(app));
  const built = APPS.filter((app) => !app.soon).length;
  return (
    <Stack gap="xl">
      <Stack gap="md">
        <Grid minCellWidth="10.5rem" mode="fit" gap="md">
          {featured.map((app) => (
            <FeaturedApp key={app.id} app={app} />
          ))}
        </Grid>
        <div className="website-shelf-rest">
          {rest.map((app) => (
            <AppChip key={app.id} app={app} />
          ))}
          <AllApps count={built} />
        </div>
      </Stack>
    </Stack>
  );
}

/**
 * One app as a picture: its screenshot with "Try it live" on it, then its
 * tile, name and one line. The card opens the app's own card in the gallery
 * (`;app=`, like a tile); only "Try it live" starts the live demo on it.
 *
 * Both are buttons, so neither can hold the other: the card's link is a
 * full-bleed button BEHIND the picture and caption (the layer's own pattern,
 * `website-layer-hit`), and "Try it live" a button of its own above them.
 */
function FeaturedApp({ app }: { app: CatalogApp }) {
  const openPane = useOpenPane();
  const appLinkProps = useAppLinkProps();
  const livePath = tryLivePath(app);
  if (livePath === undefined || app.shot === undefined) {
    throw new Error(
      `apps shelf: "${app.id}" is featured but has no live demo place or screenshot`,
    );
  }
  return (
    <div className="website-shelf-feat">
      <button
        type="button"
        className="website-shelf-feat-hit"
        aria-label={app.name}
        {...openPane.link(appsPane, { app: app.id }, { mode: "root" })}
      />
      <span className="website-shelf-feat-body">
        <span className="website-shelf-shot">
          <img
            src={app.shot.src}
            width={app.shot.width}
            height={app.shot.height}
            alt=""
            loading="lazy"
            decoding="async"
          />
          <button
            type="button"
            className="website-shelf-try"
            aria-label={`Try ${app.name} live`}
            {...appLinkProps(livePath)}
            onClickCapture={() => track("landing_try_live", { app: app.id })}
          >
            <Icon icon={playIcon} active />
            <Text as="span" variant="caption" className="font-semibold">
              Try it live
            </Text>
          </button>
        </span>
        <span className="website-shelf-cap">
          <span className="website-shelf-head">
            <AppIconTile
              icon={catalogAppIcon(app)}
              appId={app.id}
              className={cn("size-6", rigidClass())}
            />
            <Text as="span" variant="label" className="font-semibold">
              {app.name}
            </Text>
          </span>
          <Text as="span" variant="caption" tone="muted" className="block">
            {app.summary ?? app.description}
          </Text>
        </span>
      </span>
    </div>
  );
}

/**
 * One app as a small tile: its tile and name, what it does in the
 * tooltip. Opens the gallery scrolled to the app's own card (`;app=`).
 */
function AppChip({ app }: { app: CatalogApp }) {
  const openPane = useOpenPane();
  return (
    <button
      type="button"
      className={cn("website-shelf-chip", app.soon && "is-soon")}
      title={app.description}
      {...openPane.link(appsPane, { app: app.id }, { mode: "root" })}
    >
      <AppIconTile
        icon={catalogAppIcon(app)}
        appId={app.id}
        className={cn("website-shelf-chip-tile size-7", rigidClass())}
      />
      <Text as="span" variant="label" className="font-semibold">
        {app.name}
      </Text>
      {app.soon && (
        <Text
          as="span"
          variant="eyebrow"
          tone="faint"
          className="font-semibold tracking-widest"
        >
          Soon
        </Text>
      )}
    </button>
  );
}

/** The one filled control at rest: the whole gallery. */
function AllApps({ count }: { count: number }) {
  const openPane = useOpenPane();
  return (
    <button
      type="button"
      className="website-shelf-all"
      {...openPane.link(appsPane, {}, { mode: "root" })}
    >
      <Text as="span" variant="label" className="font-semibold">
        All {count} apps
      </Text>
      <Icon icon={arrowForwardIcon} className="website-shelf-all-arrow" />
    </button>
  );
}
