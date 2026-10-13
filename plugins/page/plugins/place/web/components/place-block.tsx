import { useCallback, useState } from "react";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  BLOCK_INSET,
  type BlockRendererProps,
} from "@plugins/page/plugins/editor/web";
import {
  placeBlock,
  placeDataFromSnapshot,
  type PlaceSnapshot,
  type PlaceSuggestion,
} from "../../core";
import { usePlaceProviders } from "../internal/use-place-providers";
import { usePlaceResolve } from "../internal/use-place-resolve";
import type { PlaceProviderContribution } from "../slots";
import { PlaceCard } from "./place-card";
import { PlaceSearch } from "./place-search";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

const locationOnIcon = symbol("location-on");

/**
 * Three render states, keyed on `(placeId, name, fetchedAt)` — the place block's
 * version of the bookmark block's `(url, fetched)` ladder:
 *
 *  1. no `placeId` → the search box (or the provider's own "not set up yet"
 *     action, when it says it is not usable).
 *  2. `placeId` with a missing or expired snapshot → resolve it once, then write
 *     the snapshot plus its `fetchedAt` stamp. A snapshot that is merely EXPIRED
 *     keeps rendering while the refresh runs — a month-old address beats a blank
 *     box, and blanking it is the failure mode this split exists to prevent.
 *  3. a fresh snapshot → the card, with no request at all.
 */
export function PlaceBlock({ block, editor }: BlockRendererProps) {
  const data = placeBlock.parse(block.data);
  const providers = usePlaceProviders();

  // ONE token per search-to-selection round: minted here, sent with every search
  // of the round AND with the resolve that ends it, then replaced. Providers
  // that bill a round as a unit read it to join the two.
  const [session, setSession] = useState(() => crypto.randomUUID());

  const { providerId, placeId } = data;
  // Whether there is anything to RENDER is a pure question about the stored
  // data. Whether it is old enough to refresh is a question about the clock,
  // and only the resolve effect may ask that one — reading `Date.now()` here
  // would make this component's output depend on when React happened to
  // re-render it.
  const hasSnapshot = data.name !== undefined && data.name !== "";

  const onResolved = useCallback(
    (resolvedProviderId: string, snapshot: PlaceSnapshot) => {
      editor.update(
        placeDataFromSnapshot(resolvedProviderId, snapshot, Date.now()),
      );
      // The round is over — the next search starts a new one.
      setSession(crypto.randomUUID());
    },
    [editor, setSession],
  );

  const resolve = usePlaceResolve({
    providerId,
    placeId,
    snapshot: data,
    session,
    onResolved,
  });

  function pick(pickedProviderId: string, suggestion: PlaceSuggestion) {
    // Write the identity only. The resolve that follows writes the snapshot, so
    // manual search and any future "convert into a place" path share one path.
    editor.update({
      providerId: pickedProviderId,
      placeId: suggestion.placeId,
    });
  }

  if (placeId === undefined) {
    return (
      <Inset x={BLOCK_INSET} y="xs">
        <EmptyPlaceBlock
          providers={providers}
          session={session}
          onPick={pick}
        />
      </Inset>
    );
  }

  // A place with an id but no provider cannot be resolved by anyone — the block
  // was hand-written, or its provider plugin is gone. Say that, rather than
  // spinning forever on a request nobody can make.
  if (providerId === undefined && !hasSnapshot) {
    return (
      <Inset x={BLOCK_INSET} y="xs">
        <Card>
          <Placeholder tone="error">
            This place names no provider, so it cannot be looked up. Replace it
            to search again.
          </Placeholder>
        </Card>
      </Inset>
    );
  }

  if (!hasSnapshot) {
    return (
      <Inset x={BLOCK_INSET} y="xs">
        <Card>
          <Line>
            <Icon
              icon={locationOnIcon}
              className={cn(rigidClass(), "size-4 text-muted-foreground")}
            />
            <Fill>
              {resolve.error ? (
                <Placeholder tone="error">{resolve.error}</Placeholder>
              ) : (
                <Loading variant="text" label="Looking up this place…" />
              )}
            </Fill>
          </Line>
        </Card>
      </Inset>
    );
  }

  return (
    <Inset x={BLOCK_INSET} y="xs">
      {/* A failed refresh keeps the stored snapshot on screen — the refresh
          failed, the place did not disappear. */}
      <PlaceCard
        data={data}
        refresh={resolve}
        onReplace={() => editor.update({})}
      />
    </Inset>
  );
}

/** State 1: pick a provider (only when there is a choice), then search it. */
function EmptyPlaceBlock({
  providers,
  session,
  onPick,
}: {
  providers: readonly PlaceProviderContribution[];
  session: string;
  onPick: (providerId: string, suggestion: PlaceSuggestion) => void;
}) {
  const [chosenId, setChosenId] = useState<string | undefined>(undefined);

  if (providers.length === 0) {
    return (
      <Card>
        <Placeholder tone="error">
          No place provider is installed, so there is nothing to search.
        </Placeholder>
      </Card>
    );
  }

  // With exactly one provider it is used silently; the picker appears only when
  // there is an actual choice to make.
  const provider = providers.find((p) => p.id === chosenId) ?? providers[0]!;

  return (
    <Card>
      <Stack gap="xs">
        {providers.length > 1 ? (
          <SegmentedControl
            options={providers.map((p) => ({ id: p.id, label: p.label }))}
            value={provider.id}
            onChange={setChosenId}
          />
        ) : null}
        <ProviderGate
          provider={provider}
          session={session}
          onPick={(suggestion) => onPick(provider.id, suggestion)}
        />
      </Stack>
    </Card>
  );
}

interface GateProps {
  provider: PlaceProviderContribution;
  session: string;
  onPick: (suggestion: PlaceSuggestion) => void;
}

/**
 * `useReady` presence is stable per contribution instance (it is declared in the
 * contribution literal), so branching on it here keeps both arms
 * rules-of-hooks clean — the shape auth's `ScopeGrantNotice` uses.
 */
function ProviderGate(props: GateProps) {
  if (props.provider.useReady) {
    return <GatedSearch {...props} useReady={props.provider.useReady} />;
  }
  return <PlaceSearch {...props} />;
}

function GatedSearch({
  useReady,
  ...props
}: GateProps & { useReady: Hook<() => boolean> }) {
  const ready = useReady();
  if (ready) return <PlaceSearch {...props} />;

  const Action = props.provider.AccessAction;
  if (Action) return <Action />;
  // A provider that declares itself not ready but offers no way to fix it: say
  // so plainly rather than rendering a search box whose every query would fail.
  return (
    <Placeholder tone="error">
      {props.provider.label} is not set up yet.
    </Placeholder>
  );
}
