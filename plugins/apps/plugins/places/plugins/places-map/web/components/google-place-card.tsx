import { useState, type ReactNode, type Ref } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type {
  PlaceCandidate,
  PlaceRichDetails,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { usePlaceDetails } from "@plugins/apps/plugins/places/plugins/place-details/web";
import type { AskPickNote } from "../internal/ask-picks";
import { washInk } from "../internal/pin-paint";
import type { GoogleHit } from "./google-result-card";
import { cardColumnProps, type CardFrame } from "./card-frame";
import {
  DetailsNotice,
  GoogleCredit,
  GoogleFactRows,
  MapsActions,
  OpenNowLine,
  RatingLine,
} from "./place-facts";
import { PlaceHero } from "./place-hero";
import {
  PhotosGrid,
  PhotosHeader,
  PhotoThumbs,
  ScrollTopOnMount,
} from "./place-photos";
import { PickSources } from "./pick-sources";

const closeIcon = symbol("close");
const saveIcon = symbol("add");
const whyIcon = symbol("auto-awesome");

/** A Google hit the detail card can show: one with its full candidate (a position). */
export type DetailedHit = GoogleHit & { result: PlaceCandidate };

/**
 * A Google place not saved yet — one of Sonnet's picks, or a search hit's
 * ghost pin — as a floating card the size of the place card: Google's photos
 * (else its would-be tags' wash), its name, what and where it is, rating and
 * price, open now; Sonnet's why / about / sources for a pick; Google's
 * summary and facts (the week, address, phone, website); and a footer with
 * Open in Google Maps, Directions and Save. Google's rich facts are read when
 * it opens (`place-details`, kept a day on the server), never stored.
 */
export function GooglePlaceCard({
  hit,
  pick,
  frame,
  ref,
  onClose,
  onSave,
}: {
  hit: DetailedHit;
  pick: AskPickNote | null;
  /** Floating on the map, or drilled into the side panel. */
  frame: CardFrame;
  /** The card's box (what a click away is measured against). */
  ref?: Ref<HTMLElement>;
  onClose: () => void;
  /** Save it — the screen then shows it as a saved place. */
  onSave: () => Promise<void>;
}): ReactNode {
  const details = usePlaceDetails(hit.placeId);
  const [photosOpen, setPhotosOpen] = useState(false);
  const rich: PlaceRichDetails | null =
    details.status === "ready" && details.data.kind === "ok"
      ? details.data.details
      : null;
  // Past the details budget the answer is photos alone: the search hit's own
  // rating and hours (from a rich search) stand in for them.
  const facts =
    details.status === "ready" &&
    details.data.kind === "ok" &&
    details.data.tier !== "photos"
      ? details.data.details
      : null;
  const { result, visual } = hit;
  const closed =
    result.businessStatus !== undefined &&
    result.businessStatus !== "OPERATIONAL";
  const ink = washInk(visual.mainColor);
  const mapsPlace = {
    googlePlaceId: hit.placeId,
    name: hit.name,
    address: result.address ?? "",
    location: { lat: result.lat, lng: result.lng },
  };
  // The card and its photos panel are one element, so its width glides
  // in every frame (drilled into the side panel, the panel widens with it).
  const showPhotos = photosOpen && rich !== null;
  return (
    <Column
      ref={ref}
      {...cardColumnProps(
        frame,
        showPhotos
          ? {
              header: (
                <PhotosHeader
                  place={mapsPlace}
                  count={rich.photos.length}
                  onBack={() => setPhotosOpen(false)}
                />
              ),
            }
          : null,
      )}
      body={
        showPhotos ? (
          <PhotosGrid photos={rich.photos} place={mapsPlace} />
        ) : (
          <>
            <ScrollTopOnMount />
            <PlaceHero
              photos={
                details.status === "loading"
                  ? "loading"
                  : rich !== null
                    ? rich.photos
                    : []
              }
              visual={{
                colors: [visual.mainColor],
                mainColor: visual.mainColor,
                icon: visual.icon,
              }}
              onShowAll={() => setPhotosOpen(true)}
            >
              {frame.kind === "floating" ? (
                <IconButton
                  icon={closeIcon}
                  label="Close"
                  onClick={onClose}
                  variant="floating"
                  className="rounded-full"
                />
              ) : null}
            </PlaceHero>
            <Stack gap="lg" className="p-md">
              <Stack gap="2xs">
                <Text variant="title" tone="strong">
                  {hit.name}
                </Text>
                {hit.line === undefined ? null : (
                  <Text variant="caption" tone="muted">
                    {hit.line}
                  </Text>
                )}
                <RatingLine details={facts ?? result} />
                {closed ? (
                  <Cluster>
                    <Badge
                      variant={
                        result.businessStatus === "CLOSED_PERMANENTLY"
                          ? "destructive"
                          : "warning"
                      }
                      shape="pill"
                    >
                      {result.businessStatus === "CLOSED_PERMANENTLY"
                        ? "Permanently closed"
                        : "Temporarily closed"}
                    </Badge>
                  </Cluster>
                ) : details.status === "loading" ? (
                  <Loading variant="text" label="Asking Google…" />
                ) : (
                  <OpenNowLine details={facts ?? result} />
                )}
              </Stack>
              {pick === null ? null : <PickNote pick={pick} />}
              <DetailsNotice details={details} />
              {rich !== null ? (
                <PhotoThumbs
                  photos={rich.photos}
                  onShowAll={() => setPhotosOpen(true)}
                />
              ) : null}
              {rich?.summary !== undefined ? (
                <Text variant="body" tone="muted">
                  {rich.summary}
                </Text>
              ) : null}
              <Stack gap="none">
                <GoogleFactRows
                  rich={rich}
                  address={result.address ?? ""}
                  closed={closed}
                />
              </Stack>
              {rich !== null ? <GoogleCredit /> : null}
            </Stack>
          </>
        )
      }
      footer={
        showPhotos ? undefined : (
          <MapsActions place={mapsPlace} ink={ink}>
            <Button variant="outline" onClick={onSave}>
              <Icon icon={saveIcon} />
              Save
            </Button>
          </MapsActions>
        )
      }
    />
  );
}

/** Sonnet's words on a pick: the facts it checked, what makes it special, its sources. */
function PickNote({ pick }: { pick: AskPickNote }): ReactNode {
  return (
    <Stack
      gap="xs"
      className="rounded-md bg-primary/10 px-sm py-xs text-primary-text"
    >
      <Stack direction="row" gap="xs" align="start">
        <Icon icon={whyIcon} className="size-4" />
        <Text variant="caption" tone="strong">
          {`#${pick.n} · ${pick.why}`}
        </Text>
      </Stack>
      {pick.about === undefined ? null : (
        <Text variant="body">{pick.about}</Text>
      )}
      {pick.sources.length === 0 ? null : (
        <PickSources sources={pick.sources} />
      )}
    </Stack>
  );
}
