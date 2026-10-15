import type { ReactNode } from "react";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import {
  Button,
  Textarea,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { confirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  isCustomPlace,
  isRoleTag,
  isTagUnder,
  placeName,
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
import { placeVisual } from "../internal/place-visual";
import { paleTint } from "../internal/pin-paint";
import { TagMark } from "@plugins/apps/plugins/places/plugins/tag-manager/web";
import { DROP_HEAD_PX, PlaceDropHead } from "./place-drop";
import { TagChip } from "./tag-chip";
import { TagPicker } from "./tag-picker";

const closeIcon = symbol("close");
const deleteIcon = symbol("delete");
const regenerateIcon = symbol("auto-awesome");
const moveIcon = symbol("open-with");

/** The card's two independent toggles, in order: Want to go, then Been. */
const ROLE_TOGGLES: readonly TagRole[] = ["want", "been"];

/** The card's width — the screen also reads it, to keep pins out from under it. */
export const PLACE_CARD_WIDTH = "340px";

/** The hero's drop, drawn at this multiple of the map pin. */
const HERO_SCALE = 1.9;

/**
 * The selected place, as a floating card on the right of the map: its icon on
 * a colour hero, its name (edited in place — the user's title over Google's
 * name, which then shows under it; a custom place's own name) and address;
 * the Want to go and Been toggles
 * (independent: both, one or none); its tags (path as
 * tooltip, AUTO for the ones its Google type set) with remove and "+ Tag";
 * its note (saved when the field loses focus); its Google Maps link (a custom
 * place's opens Maps at its pin); delete. A custom place says so under its
 * name, with Move (the map takes the next click as its new position).
 * Every edit is one PATCH; the live row brings it back.
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

  return (
    <Surface
      level="overlay"
      className="h-full"
      style={{ width: PLACE_CARD_WIDTH }}
    >
      <Column
        className="h-full"
        header={
          <Line
            className="gap-md p-md"
            style={{ background: paleTint(visual.mainColor) }}
          >
            {/* The hero drop: the pin's head scaled up from its centre, with
                margins for the room the scale takes beyond its box. */}
            <span
              className="relative block"
              style={{
                width: DROP_HEAD_PX,
                height: DROP_HEAD_PX,
                scale: String(HERO_SCALE),
                margin: (DROP_HEAD_PX * (HERO_SCALE - 1)) / 2,
              }}
            >
              <PlaceDropHead visual={visual} />
            </span>
            <Fill>
              <Stack gap="2xs">
                <PlaceTitleInput
                  place={place}
                  onCommit={(title) =>
                    updatePlace.mutateAsync({ params, body: { title } })
                  }
                />
                {place.title !== null ? (
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
                {place.address !== "" ? (
                  <Text variant="caption" tone="muted">
                    {place.address}
                  </Text>
                ) : null}
                <ClosedLine status={place.businessStatus} />
                <LostLine lostAt={place.googleLostAt} />
                <IconLine place={place} ownIcon={visual.ownIcon} />
              </Stack>
            </Fill>
            <IconButton icon={closeIcon} label="Close" onClick={onClose} />
          </Line>
        }
        body={
          <Stack gap="lg" className="p-md">
            <Cluster gap="xs">
              {ROLE_TOGGLES.map((role) => {
                const tag = roleTag(role, byId, tags);
                const on = place.tags.includes(tag.id);
                return (
                  <ToggleChip
                    key={role}
                    variant="tinted"
                    active={on}
                    icon={<TagMark tag={tag} tags={tags} />}
                    onClick={() =>
                      void setTags(
                        on
                          ? place.tags.filter((id) => id !== tag.id)
                          : [...place.tags, tag.id],
                      )
                    }
                  >
                    {tag.name}
                  </ToggleChip>
                );
              })}
            </Cluster>
            <Section label="Tags">
              <Cluster gap="xs">
                {shownTags.map((t) => (
                  <TagChip
                    key={t.id}
                    tag={t}
                    tags={tags}
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
            <Section label="Note">
              <Textarea
                // Keyed by place and stored note: a note saved elsewhere, or
                // another place selected, resets the uncontrolled field.
                key={`${place.id}:${place.note}`}
                defaultValue={place.note}
                fitContent
                placeholder="Why this place? Who told you about it?"
                aria-label="Note"
                onBlur={(e) => {
                  const note = e.currentTarget.value;
                  if (note !== place.note) {
                    void updatePlace.mutateAsync({ params, body: { note } });
                  }
                }}
              />
            </Section>
            <Section label="Details">
              <Stack gap="2xs">
                {place.primaryType !== null ? (
                  <Text variant="caption" tone="muted">
                    {`Google type · ${place.primaryType.replaceAll("_", " ")}`}
                  </Text>
                ) : null}
                <Text variant="caption" tone="muted">
                  {`Saved ${place.createdAt.toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}`}
                </Text>
              </Stack>
            </Section>
            <Line className="gap-xs">
              <Button
                variant="outline"
                render={
                  <a href={mapsHref(place)} target="_blank" rel="noreferrer" />
                }
              >
                <Icon icon={navIcons.newTab} />
                Open in Google Maps
              </Button>
              <Fill />
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
          </Stack>
        }
      />
    </Surface>
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
      className="min-h-0 resize-none border-transparent bg-transparent text-heading shadow-none hover:border-input focus-visible:bg-background"
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
 * Google's word that the place is closed, under its address: permanently in
 * the destructive tone (its pin is grey too), temporarily muted. Nothing for
 * an open place, or one Google gives no status for.
 */
function ClosedLine({
  status,
}: {
  status: Place["businessStatus"];
}): ReactNode {
  if (status === "CLOSED_PERMANENTLY") {
    return (
      <Text variant="caption" tone="destructive">
        Permanently closed
      </Text>
    );
  }
  if (status === "CLOSED_TEMPORARILY") {
    return (
      <Text variant="caption" tone="muted">
        Temporarily closed
      </Text>
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
 * Where the place's icon came from. Haiku picks it right after the save; until
 * it has (or when it could not), the pin wears its main tag's icon and this
 * says so. Regenerate re-asks Haiku — the button shows its own pending state
 * for the call's lifetime.
 */
function IconLine({
  place,
  ownIcon,
}: {
  place: Place;
  ownIcon: boolean;
}): ReactNode {
  const regenerate = useRegeneratePlaceIcon();
  // A wrapping cluster, not a line: the hero's text column is narrow, and
  // the provenance must read whole beside its action.
  return (
    <Cluster gap="xs" align="center">
      <Text variant="caption" tone="faint">
        {ownIcon ? "Icon by Haiku" : "No icon yet"}
      </Text>
      <Button
        variant="link"
        aspect="inline"
        onClick={() => regenerate.mutateAsync({ params: { id: place.id } })}
      >
        <Icon icon={regenerateIcon} />
        {ownIcon ? "Regenerate" : "Pick one"}
      </Button>
    </Cluster>
  );
}
