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
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import {
  Button,
  Textarea,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { confirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  isStatusTag,
  isTagUnder,
  type Place,
  type PlaceStatus,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  useDeletePlace,
  useRegeneratePlaceIcon,
  useUpdatePlace,
} from "@plugins/apps/plugins/places/plugins/places-core/web";
import { placeVisual } from "../internal/place-visual";
import { paleTint } from "../internal/pin-paint";
import { DROP_HEAD_PX, PlaceDropHead } from "./place-drop";
import { TagChip } from "./tag-chip";
import { TagPicker } from "./tag-picker";

const closeIcon = symbol("close");
const deleteIcon = symbol("delete");
const regenerateIcon = symbol("auto-awesome");

const STATUS_OPTIONS = [
  { id: "todo", label: "Todo" },
  { id: "done", label: "Done" },
] as const satisfies readonly { id: PlaceStatus; label: string }[];

/** The card's width — the screen also reads it, to keep pins out from under it. */
export const PLACE_CARD_WIDTH = "340px";

/** The hero's drop, drawn at this multiple of the map pin. */
const HERO_SCALE = 1.9;

/**
 * The selected place, as a floating card on the right of the map: its icon on
 * a colour hero, name and address; the Todo / Done switch; its tags (path as
 * tooltip, AUTO for the ones its Google type set) with remove and "+ Tag";
 * its note (saved when the field loses focus); its Google Maps link; delete.
 * Every edit is one PATCH; the live row brings it back.
 */
export function PlaceCard({
  place,
  tags,
  onClose,
}: {
  place: Place;
  tags: readonly PlaceTag[];
  onClose: () => void;
}) {
  const updatePlace = useUpdatePlace();
  const deletePlace = useDeletePlace();
  const visual = placeVisual(place, tags);
  const params = { id: place.id };
  const byId = new Map<string, PlaceTag>(tags.map((t) => [t.id, t]));
  const shownTags = place.tags
    .filter((id) => !isStatusTag(id, tags))
    .map((id) => byId.get(id))
    .filter((t): t is PlaceTag => t !== undefined);

  const setTags = (next: string[]) =>
    updatePlace.mutateAsync({ params, body: { tags: next } });
  const mapsHref =
    place.mapsUrl ??
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${place.name} ${place.address}`,
    )}`;

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
                <Text variant="heading">{place.name}</Text>
                <Text variant="caption" tone="muted">
                  {place.address}
                </Text>
                <IconLine place={place} ownIcon={visual.ownIcon} />
              </Stack>
            </Fill>
            <IconButton icon={closeIcon} label="Close" onClick={onClose} />
          </Line>
        }
        body={
          <Stack gap="lg" className="p-md">
            <Section label="Status">
              <SegmentedControl
                label="Status"
                options={STATUS_OPTIONS}
                value={visual.status}
                onChange={(status) =>
                  void updatePlace.mutateAsync({ params, body: { status } })
                }
              />
            </Section>
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
                render={<a href={mapsHref} target="_blank" rel="noreferrer" />}
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
                    title: `Delete “${place.name}”?`,
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
