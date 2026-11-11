import type { CSSProperties } from "react";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { AVATAR_COLOR_NAMES } from "@plugins/primitives/plugins/avatar/core";
import {
  Avatar,
  AvatarPresentationProvider,
} from "@plugins/primitives/plugins/avatar/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { embedTailPath } from "@plugins/primitives/plugins/pane/core";
import { useAppLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { track } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import { downloadPane } from "@plugins/apps/plugins/website/plugins/pages/plugins/download/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { APP_DEMO_PLACES } from "../../core";
import type { AppCategory, CatalogApp } from "../internal/catalog";

/**
 * One app of the gallery: its picture, its tile and name, what it does, and
 * Install — which goes to the download page, because installing happens in
 * equin itself, never on the site. An app not built yet is drawn dashed and
 * faded, with a Soon badge where Install would be. Its sizes are the gallery's
 * (`equinGalleryTheme`, worn by the gallery around it).
 *
 * An app the homepage's live demo carries (`APP_DEMO_PLACES`) is a link as a
 * whole: the card opens the demo maximized, at that app
 * (`/about/at/<place>;full=1` — the embed's own place in the homepage's
 * URL), so the reader tries the app instead of reading about it. The link is
 * a full-bleed button BEHIND the card's content, so Install stays a control
 * of its own above it; the picture's "Try it live" chip says the card opens
 * before it is hovered (a touch screen never hovers).
 */
export function AppCard({
  app,
  category,
}: {
  app: CatalogApp;
  category: AppCategory;
}) {
  const openPane = useOpenPane();
  const appLinkProps = useAppLinkProps();
  const demoPlace = APP_DEMO_PLACES[app.id];
  // The app's categorical slot, read by the drawn picture's accent (see the CSS).
  const tint = {
    "--app-tint": `var(--categorical-${AVATAR_COLOR_NAMES.indexOf(app.color) + 1})`,
  } as CSSProperties;
  return (
    <Card
      className={cn(
        "website-app-card rounded-2xl shadow-none",
        app.soon && "is-soon",
        demoPlace !== undefined && "is-live",
      )}
      style={tint}
    >
      {demoPlace !== undefined && (
        <button
          type="button"
          className="website-app-open"
          aria-label={`Try ${app.name} live`}
          {...appLinkProps(
            websiteApp.basePath + embedTailPath(demoPlace, { maximized: true }),
          )}
          onClickCapture={() => track("apps_try_live", { app: app.id })}
        />
      )}
      <Stack gap="lg" className="website-app-body h-full">
        <AppThumb app={app} live={demoPlace !== undefined} />
        <Fill>
          <Stack gap="md">
            <Stack direction="row" gap="md" align="start">
              <div className={cn("website-app-tile size-13", rigidClass())}>
                <AvatarPresentationProvider value="gradient-tile">
                  <Avatar
                    symbol={app.icon}
                    color={app.color}
                    shape="squircle"
                  />
                </AvatarPresentationProvider>
              </div>
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
          src={app.shot}
          alt={app.name}
          loading="lazy"
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
