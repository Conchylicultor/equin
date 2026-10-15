import type { ComponentProps, ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  cn,
  Textarea,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { confirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  MAPS_BLOCKER_BODY,
  MapsAccessAction,
} from "@plugins/integrations/plugins/google-maps/web";
import type { PlaceRichDetails } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  isCustomPlace,
  isRoleTag,
  isTagUnder,
  placeName,
  tagColor,
  tagIdByRole,
  type Place,
  type PlaceTag,
  type TagRole,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  useDeletePlace,
  useRegeneratePlaceIcon,
  useUpdatePlace,
} from "@plugins/apps/plugins/places/plugins/places-core/web";
import { usePlaceDetails } from "@plugins/apps/plugins/places/plugins/place-details/web";
import { placeVisual, type PlaceVisual } from "../internal/place-visual";
import { washInk } from "../internal/pin-paint";
import { TagMark } from "@plugins/apps/plugins/places/plugins/tag-manager/web";
import { DROP_HEAD_PX, PlaceDropHead } from "./place-drop";
import {
  HoursRow,
  InfoRow,
  OpenNowLine,
  PhoneRow,
  RatingLine,
  WebsiteRow,
} from "./place-facts";
import { PlaceHero } from "./place-hero";
import { TagChip } from "./tag-chip";
import { TagPicker } from "./tag-picker";

const closeIcon = symbol("close");
const deleteIcon = symbol("delete");
const regenerateIcon = symbol("auto-awesome");
const moveIcon = symbol("open-with");
const addressIcon = symbol("location-on");
const savedIcon = symbol("event");
const directionsIcon = symbol("directions");
const quoteIcon = symbol("format-quote");
const infoIcon = symbol("info");

/** The card's two independent toggles, in order: Want to go, then Been. */
const ROLE_TOGGLES: readonly TagRole[] = ["want", "been"];

/** The card's width — the screen also reads it, to keep pins out from under it. */
export const PLACE_CARD_WIDTH = "340px";

/** The drop under the hero, drawn at this multiple of the map pin. */
const HERO_SCALE = 1.9;

/** The card's box: an overlay surface, laid out by the `Column` it hosts. */
function OverlayCard(props: Omit<ComponentProps<typeof Surface>, "level">) {
  return <Surface level="overlay" {...props} />;
}

/**
 * The selected place, as a floating card on the right of the map, as tall as
 * its content (the body scrolls past the screen's height):
 *
 * - the hero — Google's photos, else the tag colours' wash with the place's
 *   icon as a watermark — with the drop standing on its foot;
 * - its name (edited in place — the user's title over Google's name, which then
 *   shows under it; a custom place's own name), what it is and where, Google's
 *   rating and price, whether it is open now, a closure;
 * - Google's one-line summary; the Want to go and Been toggles (independent);
 *   its tags (path as tooltip, ✨ for the ones its Google type set) with
 *   remove and "+ Tag"; its note (saved when the field loses focus);
 * - the facts: the week's hours, address, phone, website, the saved date, the
 *   icon's provenance with Regenerate;
 * - a footer that stays: Open in Google Maps, Directions, delete.
 *
 * Google's rich facts (photos, hours, rating, phone, website, summary) are
 * read when the card opens (`place-details`, kept a day on the server), never
 * stored; a custom place has none. Every edit is one PATCH; the live row
 * brings it back.
 */
export function PlaceCard({
  place,
  tags,
  onClose,
  onMovePin,
}: {
  place: Place;
  tags: readonly PlaceTag[];
  onClose: () => void;
  /** Ask the map for the custom place's new position (pick mode). */
  onMovePin: () => void;
}) {
  const updatePlace = useUpdatePlace();
  const deletePlace = useDeletePlace();
  const details = usePlaceDetails(place.googlePlaceId);
  const visual = placeVisual(place, tags);
  const params = { id: place.id };
  const byId = new Map<string, PlaceTag>(tags.map((t) => [t.id, t]));
  const shownTags = place.tags
    .filter((id) => !isRoleTag(id, tags))
    .map((id) => byId.get(id))
    .filter((t): t is PlaceTag => t !== undefined);

  const setTags = (next: string[]) =>
    updatePlace.mutateAsync({ params, body: { tags: next } });
  const name = placeName(place);
  // Google's rich facts once they are in; a custom place has none to wait for.
  const rich: PlaceRichDetails | null =
    details.status === "ready" && details.data.kind === "ok"
      ? details.data.details
      : null;
  const richPending =
    place.googlePlaceId !== null && details.status === "loading";
  const closed =
    place.businessStatus !== null && place.businessStatus !== "OPERATIONAL";

  return (
    <Column
      as={OverlayCard}
      className={cn(
        "pointer-events-auto max-h-full",
        clipClasses({ axis: "both", fill: false }),
      )}
      style={{ width: PLACE_CARD_WIDTH }}
      body={
        <>
          <PlaceHero
            photos={richPending ? "loading" : rich !== null ? rich.photos : []}
            visual={visual}
          >
            <IconButton
              icon={closeIcon}
              label="Close"
              onClick={onClose}
              variant="floating"
              className="rounded-full"
            />
          </PlaceHero>
          <Stack direction="row" align="start" gap="md" className="px-md">
            <HeroDrop visual={visual} />
            <Fill>
              <Stack gap="2xs" className="pt-sm">
                <PlaceTitleInput
                  place={place}
                  onCommit={(title) =>
                    updatePlace.mutateAsync({ params, body: { title } })
                  }
                />
                {place.title !== null && place.googlePlaceId !== null ? (
                  <Text variant="caption" tone="faint">
                    {`On Google: ${place.name}`}
                  </Text>
                ) : null}
                {isCustomPlace(place) ? (
                  <Cluster gap="xs" align="center">
                    <Text variant="caption" tone="faint">
                      Custom pin — no Google place
                    </Text>
                    <Button variant="link" aspect="inline" onClick={onMovePin}>
                      <Icon icon={moveIcon} />
                      Move
                    </Button>
                  </Cluster>
                ) : null}
                <KindLine place={place} visual={visual} />
                {richPending ? (
                  <Loading variant="text" label="Asking Google…" />
                ) : rich !== null ? (
                  <>
                    <RatingLine details={rich} />
                    {closed ? null : <OpenNowLine details={rich} />}
                  </>
                ) : null}
                <ClosedLine status={place.businessStatus} />
                <LostLine lostAt={place.googleLostAt} />
              </Stack>
            </Fill>
          </Stack>
          <Stack gap="lg" className="p-md">
            {details.status === "error" ? (
              <ResourceErrorInline
                variant="block"
                subject="Google's details of this place"
                error={details.error}
                refetch={details.refetch}
              />
            ) : details.status === "ready" &&
              details.data.kind === "maps-not-configured" ? (
              <Stack gap="sm">
                <Text variant="caption" tone="muted">
                  {MAPS_BLOCKER_BODY["not-configured"]}
                </Text>
                <MapsAccessAction />
              </Stack>
            ) : null}
            {rich?.summary !== undefined ? (
              <Text variant="body" tone="muted">
                {rich.summary}
              </Text>
            ) : null}
            <Line className="gap-xs">
              {ROLE_TOGGLES.map((role) => {
                const tag = roleTag(role, byId, tags);
                const on = place.tags.includes(tag.id);
                return (
                  <Fill key={role}>
                    <RoleToggle
                      tag={tag}
                      tags={tags}
                      on={on}
                      onToggle={() =>
                        void setTags(
                          on
                            ? place.tags.filter((id) => id !== tag.id)
                            : [...place.tags, tag.id],
                        )
                      }
                    />
                  </Fill>
                );
              })}
            </Line>
            <Section label="Tags">
              <Cluster gap="xs">
                {shownTags.map((t) => (
                  <TagChip
                    key={t.id}
                    tag={t}
                    tags={tags}
                    tinted
                    auto={place.autoTags.includes(t.id)}
                    onRemove={() =>
                      void setTags(place.tags.filter((id) => id !== t.id))
                    }
                  />
                ))}
                <TagPicker
                  tags={tags}
                  exclude={place.tags}
                  onPick={(tagId) =>
                    // A tag replaces the ancestors of it the place carried:
                    // "Restaurants › French" says "Restaurants" already.
                    void setTags([
                      ...place.tags.filter(
                        (id) => !isTagUnder(tagId, id, tags),
                      ),
                      tagId,
                    ])
                  }
                />
              </Cluster>
            </Section>
            <NoteSlip
              place={place}
              onCommit={(note) =>
                updatePlace.mutateAsync({ params, body: { note } })
              }
            />
            <Stack gap="none">
              {rich !== null && !closed ? <HoursRow details={rich} /> : null}
              {place.address !== "" ? (
                <InfoRow
                  icon={addressIcon}
                  action={
                    <CopyButton text={place.address} title="Copy address" />
                  }
                >
                  <Text variant="body">{place.address}</Text>
                </InfoRow>
              ) : null}
              {rich?.phone !== undefined ? (
                <PhoneRow phone={rich.phone} />
              ) : null}
              {rich?.website !== undefined ? (
                <WebsiteRow website={rich.website} />
              ) : null}
              <InfoRow icon={savedIcon}>
                <Stack gap="none">
                  <Text variant="body">
                    {`Saved ${place.createdAt.toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}`}
                  </Text>
                  {place.primaryType !== null ? (
                    <Text variant="caption" tone="faint">
                      {`Google type · ${place.primaryType.replaceAll("_", " ")}`}
                    </Text>
                  ) : null}
                </Stack>
              </InfoRow>
              <IconRow place={place} ownIcon={visual.ownIcon} />
            </Stack>
            {rich !== null ? (
              <Line className="gap-2xs">
                <Icon
                  icon={infoIcon}
                  className="size-3.5 text-muted-foreground"
                />
                <Text variant="caption" tone="faint">
                  Photos, hours and rating from Google
                </Text>
              </Line>
            ) : null}
          </Stack>
        </>
      }
      footer={
        <Line className="gap-xs border-t p-md">
          <Fill>
            <Button
              className="w-full text-white hover:opacity-90"
              style={{ background: washInk(visual.mainColor) }}
              render={
                <a href={mapsHref(place)} target="_blank" rel="noreferrer" />
              }
            >
              <Icon icon={navIcons.newTab} />
              Open in Google Maps
            </Button>
          </Fill>
          <IconButton
            icon={directionsIcon}
            label="Directions"
            variant="outline"
            render={
              <a
                href={directionsHref(place)}
                target="_blank"
                rel="noreferrer"
              />
            }
          />
          <IconButton
            icon={deleteIcon}
            label="Delete place"
            onClick={() =>
              void confirmDialog({
                title: `Delete “${name}”?`,
                description:
                  "It leaves your map, with its tags and note. Saving it again starts afresh.",
                confirmLabel: "Delete place",
                onConfirm: async () => {
                  await deletePlace.mutateAsync({ params });
                  onClose();
                },
              })
            }
          />
        </Line>
      }
    />
  );
}

/** The pin's head scaled up from its centre, standing on the hero's foot. */
function HeroDrop({ visual }: { visual: PlaceVisual }): ReactNode {
  const room = (DROP_HEAD_PX * (HERO_SCALE - 1)) / 2;
  return (
    <span
      className="relative block"
      style={{
        width: DROP_HEAD_PX,
        height: DROP_HEAD_PX,
        scale: String(HERO_SCALE),
        margin: room,
        marginTop: -(DROP_HEAD_PX / 2),
        filter: "drop-shadow(0 4px 6px rgb(0 0 0 / 0.18))",
      }}
    >
      <PlaceDropHead visual={visual} />
    </span>
  );
}

/** What the place is, as Google names its type: "🏰 Castle". */
function KindLine({
  place,
  visual,
}: {
  place: Place;
  visual: PlaceVisual;
}): ReactNode {
  if (place.primaryType === null) return null;
  const kind = place.primaryType.replaceAll("_", " ");
  return (
    <Line className="gap-2xs">
      <Icon
        icon={visual.icon}
        active
        className="size-4"
        style={{ color: washInk(visual.mainColor) }}
      />
      <Text variant="caption" tone="muted">
        {kind.charAt(0).toUpperCase() + kind.slice(1)}
      </Text>
    </Line>
  );
}

/**
 * Want to go / Been as a large toggle, wearing its tag's colour when on (the
 * colour is user data: painted through `style`).
 */
function RoleToggle({
  tag,
  tags,
  on,
  onToggle,
}: {
  tag: PlaceTag;
  tags: readonly PlaceTag[];
  on: boolean;
  onToggle: () => void;
}): ReactNode {
  const color = tagColor(tag.id, tags);
  return (
    <Button
      variant="outline"
      aria-pressed={on}
      className="w-full"
      style={
        on && color !== null
          ? {
              background: `color-mix(in srgb, ${color} 15%, transparent)`,
              borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
              color: `color-mix(in srgb, ${color} 55%, black)`,
            }
          : undefined
      }
      onClick={onToggle}
    >
      <TagMark tag={tag} tags={tags} />
      {tag.name}
    </Button>
  );
}

/** The note: a warm slip with a quote mark, saved when it loses focus. */
function NoteSlip({
  place,
  onCommit,
}: {
  place: Place;
  onCommit: (note: string) => Promise<unknown>;
}): ReactNode {
  return (
    <Stack
      direction="row"
      align="start"
      gap="xs"
      className="rounded-lg border border-warning/30 bg-warning/10 px-sm py-xs"
    >
      <Icon icon={quoteIcon} className="size-5 text-warning" />
      <Fill>
        <Textarea
          // Keyed by place and stored note: a note saved elsewhere, or
          // another place selected, resets the uncontrolled field.
          key={`${place.id}:${place.note}`}
          defaultValue={place.note}
          fitContent
          placeholder="Why this place? Who told you about it?"
          aria-label="Note"
          className="min-h-0 resize-none border-transparent bg-transparent p-none shadow-none focus-visible:ring-0"
          onBlur={(e) => {
            const note = e.currentTarget.value;
            if (note !== place.note) void onCommit(note);
          }}
        />
      </Fill>
    </Stack>
  );
}

/**
 * Where "Open in Google Maps" goes: Google's own link for a Google place
 * (else a search pinned to its id), the pin's coordinates for a custom place —
 * Google knows no place by its name.
 */
function mapsHref(place: Place): string {
  const search = "https://www.google.com/maps/search/?api=1";
  const { googlePlaceId } = place;
  if (googlePlaceId === null) {
    const { lat, lng } = place.location;
    return `${search}&query=${lat},${lng}`;
  }
  return (
    place.mapsUrl ??
    `${search}&query=${encodeURIComponent(
      `${place.name} ${place.address}`,
    )}&query_place_id=${encodeURIComponent(googlePlaceId)}`
  );
}

/**
 * Where Directions goes: Google Maps' route to the place, from wherever the
 * person is — pinned to its Google id when it has one.
 */
function directionsHref(place: Place): string {
  const { lat, lng } = place.location;
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  return place.googlePlaceId === null
    ? dir
    : `${dir}&destination_place_id=${encodeURIComponent(place.googlePlaceId)}`;
}

/**
 * The place's name, edited in place — borderless until hovered or focused,
 * saved on blur or Enter, Escape reverts. On a Google place it is the user's
 * title: blank, or Google's own name, clears it (Google's name shows again,
 * and stays up to date). On a custom place it is its name: blank reverts.
 */
function PlaceTitleInput({
  place,
  onCommit,
}: {
  place: Place;
  onCommit: (title: string | null) => Promise<unknown>;
}): ReactNode {
  const shown = placeName(place);
  const custom = isCustomPlace(place);
  return (
    <Textarea
      // Keyed by the stored name: a rename arriving from elsewhere resets the
      // uncontrolled field to it.
      key={shown}
      defaultValue={shown}
      placeholder={custom ? "Name this pin" : place.name}
      aria-label="Place name"
      // One line that wraps a long name instead of cutting it; Enter saves.
      rows={1}
      fitContent
      className="min-h-0 resize-none border-transparent bg-transparent text-title shadow-none hover:border-input focus-visible:bg-background"
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          e.currentTarget.value = shown;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => {
        const next = e.currentTarget.value.trim();
        if (next === shown) return;
        if (custom) {
          if (next === "") {
            e.currentTarget.value = shown;
            return;
          }
          void onCommit(next);
          return;
        }
        // Google's own name (or nothing) is no title.
        const title = next === "" || next === place.name ? null : next;
        if (title === place.title) {
          e.currentTarget.value = shown;
          return;
        }
        void onCommit(title);
      }}
    />
  );
}

/**
 * The tag holding `role`. The seed creates both role tags and neither can be
 * deleted, so a tree without one is broken: it throws.
 */
function roleTag(
  role: TagRole,
  byId: ReadonlyMap<string, PlaceTag>,
  tags: readonly PlaceTag[],
): PlaceTag {
  const id = tagIdByRole(tags, role);
  const tag = id === undefined ? undefined : byId.get(id);
  if (tag === undefined) {
    throw new Error(`The place tag tree has no ${role} role tag`);
  }
  return tag;
}

function Section({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactNode {
  return (
    <Stack gap="xs">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </Stack>
  );
}

/**
 * Google's word that the place is closed, as a pill under its name (in place
 * of the open-now line): permanently in the destructive tone (its pin is grey
 * too), temporarily in the warning one. Nothing for an open place, or one
 * Google gives no status for.
 */
function ClosedLine({
  status,
}: {
  status: Place["businessStatus"];
}): ReactNode {
  if (status === "CLOSED_PERMANENTLY") {
    return (
      <Cluster>
        <Badge variant="destructive" shape="pill">
          Permanently closed
        </Badge>
      </Cluster>
    );
  }
  if (status === "CLOSED_TEMPORARILY") {
    return (
      <Cluster>
        <Badge variant="warning" shape="pill">
          Temporarily closed
        </Badge>
      </Cluster>
    );
  }
  return null;
}

/**
 * Google no longer finds the place's id (the monthly refresh got NOT_FOUND):
 * what the card shows is the place as Google last described it, and nothing
 * here updates any more. Nothing while Google still finds it.
 */
function LostLine({ lostAt }: { lostAt: Place["googleLostAt"] }): ReactNode {
  if (lostAt === null) return null;
  return (
    <Text variant="caption" tone="destructive">
      {`Google link lost since ${lostAt.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })} — details as Google last gave them`}
    </Text>
  );
}

/**
 * Where the place's icon came from, as the card's last fact. Haiku picks it
 * right after the save; until it has (or when it could not), the pin wears its
 * main tag's icon and this says so. Regenerate re-asks Haiku — the button shows
 * its own pending state for the call's lifetime.
 */
function IconRow({
  place,
  ownIcon,
}: {
  place: Place;
  ownIcon: boolean;
}): ReactNode {
  const regenerate = useRegeneratePlaceIcon();
  return (
    <InfoRow
      icon={regenerateIcon}
      action={
        <Button
          variant="link"
          aspect="inline"
          onClick={() => regenerate.mutateAsync({ params: { id: place.id } })}
        >
          {ownIcon ? "Regenerate" : "Pick one"}
        </Button>
      }
    >
      <Text variant="body">{ownIcon ? "Icon by Haiku" : "No icon yet"}</Text>
    </InfoRow>
  );
}
