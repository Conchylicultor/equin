import type { CSSProperties } from "react";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { appTileFill } from "@plugins/apps-core/plugins/app-icon/core";
import { AppIconTile } from "@plugins/apps-core/plugins/app-icon/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useAppLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { useRevealOnActive } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { track } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import { downloadPane } from "@plugins/apps/plugins/website/plugins/pages/plugins/download/web";
import { tryLivePath } from "../internal/try-live";
import {
  catalogAppIcon,
  type AppCategory,
  type CatalogApp,
} from "../internal/catalog";

/**
 * One app of the gallery: its picture, its tile and name, what it does, and
 * Install — which goes to the download page, because installing happens in
 * equin itself, never on the site. An app not built yet is drawn dashed and
 * faded, with a Soon badge where Install would be. Its sizes are the gallery's
 * (`equinGalleryTheme`, worn by the gallery around it).
 *
 * An app the homepage's live demo carries (`APP_DEMO_PLACES`) is a link as a
 * whole: the card opens the demo maximized on the app's home
 * (`/about/at/<home>;full=1` — the embed's own place in the homepage's
 * URL), so the reader tries the app instead of reading about it — never on
 * the staged frame its picture shows. The link is
 * a full-bleed button BEHIND the card's content, so Install stays a control
 * of its own above it; the picture's "Try it live" chip says the card opens
 * before it is hovered (a touch screen never hovers).
 */
export function AppCard({
  app,
  category,
  focused,
}: {
  app: CatalogApp;
  category: AppCategory;
  /** The app the page was opened on: scrolled to (centred) and briefly ringed. */
  focused: boolean;
}) {
  const revealRef = useRevealOnActive(focused, {
    revealOnMount: true,
    block: "center",
  });
  const openPane = useOpenPane();
  const appLinkProps = useAppLinkProps();
  const livePath = tryLivePath(app);
  const icon = catalogAppIcon(app);
  // The app's tile colour, read by the drawn picture's accent (see the CSS).
  const tint = {
    "--app-tint": appTileFill(icon, app.id),
  } as CSSProperties;
  return (
    <Card
      ref={revealRef}
      className={cn(
        "website-app-card rounded-2xl shadow-none",
        focused && "is-focused",
        app.soon && "is-soon",
        livePath !== undefined && "is-live",
      )}
      style={tint}
    >
      {livePath !== undefined && (
        <button
          type="button"
          className="website-app-open"
          aria-label={`Try ${app.name} live`}
          {...appLinkProps(livePath)}
          onClickCapture={() => track("apps_try_live", { app: app.id })}
        />
      )}
      <Stack gap="lg" className="website-app-body h-full">
        <AppThumb app={app} live={livePath !== undefined} />
        <Fill>
          <Stack gap="md">
            <Stack direction="row" gap="md" align="start">
              <AppIconTile
                icon={icon}
                appId={app.id}
                className={cn("website-app-tile size-13", rigidClass())}
              />
              <Stack gap="none">
                <Text
                  as="h4"
                  variant="subheading"
                  className="font-semibold tracking-[-0.01em]"
                >
                  {app.name}
                </Text>
                <Text
                  variant="label"
                  tone="faint"
                  className="website-app-category font-normal"
                >
                  {category.name}
                </Text>
              </Stack>
            </Stack>
            <Text as="p" variant="body" tone="muted">
              {app.description}
            </Text>
          </Stack>
        </Fill>
        <Stack direction="row" gap="none" justify="end">
          {app.soon ? (
            <Badge
              shape="pill"
              colorClass="border border-foreground/16 text-faint-foreground font-semibold tracking-[0.07em] uppercase"
            >
              Soon
            </Badge>
          ) : (
            <Button
              variant="outline"
              shape="pill"
              className="website-app-install font-semibold"
              {...openPane.link(downloadPane, {}, { mode: "root" })}
            >
              Install
            </Button>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

/**
 * The card's picture: the app's screenshot, or — for an app without one — a
 * drawing of an app: a side list with the app's accent on one row, a heading
 * and a grid of tiles.
 */
function AppThumb({ app, live }: { app: CatalogApp; live: boolean }) {
  if (app.shot !== undefined) {
    return (
      <div className="website-app-thumb">
        <img
          className="website-app-shot"
          src={app.shot.src}
          width={app.shot.width}
          height={app.shot.height}
          alt={app.name}
          loading="lazy"
          decoding="async"
        />
        {live && <TryLiveChip />}
      </div>
    );
  }
  return (
    <div className="website-app-thumb" aria-hidden>
      <div className="website-app-thumb-side">
        <i className="website-app-thumb-line is-heading" />
        <i className="website-app-thumb-line" />
        <i className="website-app-thumb-line is-accent w-[70%]" />
        <i className="website-app-thumb-line" />
        <i className="website-app-thumb-line w-[60%]" />
      </div>
      <div className="website-app-thumb-main">
        <i className="website-app-thumb-line is-heading" />
        <i className="website-app-thumb-line w-[80%]" />
        <div className="website-app-thumb-tiles">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
      {live && <TryLiveChip />}
    </div>
  );
}

/**
 * The picture's corner chip on a card that opens the live demo: always drawn,
 * so the card says it opens before the pointer is near it; brighter while the
 * card is hovered or focused (`apps-gallery.css`).
 */
function TryLiveChip() {
  return (
    <span className="website-app-live" aria-hidden>
      <Icon icon={symbol("play-arrow")} />
      <Text as="span" variant="label" className="font-semibold">
        Try it live
      </Text>
    </span>
  );
}
