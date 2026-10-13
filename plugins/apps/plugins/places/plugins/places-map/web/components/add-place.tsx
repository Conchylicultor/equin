import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { useState, type ReactNode } from "react";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  MAPS_BLOCKER_BODY,
  MapsAccessAction,
} from "@plugins/integrations/plugins/google-maps/web";
import type { Place } from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  usePlaceSearch,
  useSavePlace,
} from "@plugins/apps/plugins/places/plugins/places-core/web";
import { useDebouncedValue } from "../internal/use-debounced-value";

const addIcon = symbol("add-location-alt");
const placeIcon = symbol("location-on");

/** How long typing must pause before a search is asked. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * "Add place": the primary action of the floating toolbar, opening a Google
 * Places search. Picking a result saves it (auto-tagged from its Google
 * types, tagged Todo, its icon picked by Haiku right after) and selects it.
 */
export function AddPlaceButton({
  onSaved,
}: {
  /** The place just saved — or the one already saved for that Google place. */
  onSaved: (place: Place) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      size="described"
      maxHeight="lg"
      align="end"
      label="Add place"
      trigger={
        <Button variant="default">
          <Icon icon={addIcon} />
          Add place
        </Button>
      }
    >
      {/* Mounted only while open: each opening is one search-to-pick round,
          with its own session token. */}
      {open ? (
        <AddPlaceSearch
          onSaved={(place) => {
            setOpen(false);
            onSaved(place);
          }}
        />
      ) : null}
    </ControlPanelPopover>
  );
}

function AddPlaceSearch({
  onSaved,
}: {
  onSaved: (place: Place) => void;
}): ReactNode {
  // One autocomplete session per opening: every keystroke's search and the
  // save that ends it share it, so Google bills the round as one session.
  const [session] = useState(() => crypto.randomUUID());
  const [text, setText] = useState("");
  const q = useDebouncedValue(text.trim(), SEARCH_DEBOUNCE_MS);
  const search = usePlaceSearch(q === "" ? null : { q, session });
  const savePlace = useSavePlace();
  const [notConfigured, setNotConfigured] = useState(false);

  const pick = async (googlePlaceId: string) => {
    const result = await savePlace.mutateAsync({
      body: { googlePlaceId, session },
    });
    if (result.kind === "maps-not-configured") setNotConfigured(true);
    else onSaved(result.place);
  };

  return (
    <>
      <ControlPanel.Section>
        <SearchInput
          appearance="menu"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search Google Places…"
          aria-label="Search Google Places"
        />
      </ControlPanel.Section>
      <ControlPanel.Section>
        {notConfigured ? (
          <NotConfigured />
        ) : q === "" ? (
          <ControlPanel.Empty>
            Type a name or an address. Categories are tagged automatically from
            the Google place type, and Haiku picks the icon.
          </ControlPanel.Empty>
        ) : search.status === "loading" ? (
          <Loading variant="rows" count={3} />
        ) : search.status === "error" ? (
          <ResourceErrorInline
            variant="block"
            subject="the Google Places search"
            error={search.error}
            refetch={search.refetch}
          />
        ) : search.data.kind === "maps-not-configured" ? (
          <NotConfigured />
        ) : search.data.suggestions.length === 0 ? (
          <ControlPanel.Empty>No place matches “{q}”.</ControlPanel.Empty>
        ) : (
          search.data.suggestions.map((s) =>
            // Google omits the second line for some predictions; such a row
            // is one line, not a blank description.
            s.secondary === undefined ? (
              <ControlPanel.Row
                key={s.placeId}
                icon={<Icon icon={placeIcon} />}
                onSelect={() => void pick(s.placeId)}
              >
                {s.primary}
              </ControlPanel.Row>
            ) : (
              <ControlPanel.Row
                key={s.placeId}
                icon={<Icon icon={placeIcon} />}
                description={s.secondary}
                onSelect={() => void pick(s.placeId)}
              >
                {s.primary}
              </ControlPanel.Row>
            ),
          )
        )}
      </ControlPanel.Section>
    </>
  );
}

/** Google Maps has no Places key: say so, with the control that fixes it. */
function NotConfigured(): ReactNode {
  return (
    <Stack gap="sm">
      <Text variant="caption" tone="muted">
        {MAPS_BLOCKER_BODY["not-configured"]}
      </Text>
      <MapsAccessAction />
    </Stack>
  );
}
