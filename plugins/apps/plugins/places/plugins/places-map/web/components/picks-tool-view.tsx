import { useMemo, useState, type ReactNode } from "react";
import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { useJsonlConversationId } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import type { MapPin } from "@plugins/map/core";
import { MapView } from "@plugins/map/web";
import type { PlaceCandidate } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  PlacesPicksSchema,
  type PlacesPicks,
} from "@plugins/apps/plugins/places/plugins/ask/core";
import { useAskCandidates } from "../internal/ask-picks";
import { ASK_PICK_PIN_TYPE } from "../internal/ask-pick";

/** One pick as the transcript row lists it: its rank, why, and the place behind it if known. */
interface ShownPick {
  n: number;
  placeId: string;
  why: string;
  candidate: PlaceCandidate | undefined;
}

const PIN_PREFIX = "pick:";

/** "Café Méricourt, Ten Belles, Fragments, +5" — the row's closed-state summary. */
function namesSummary(picks: readonly ShownPick[]): string | undefined {
  const named = picks.flatMap((p) =>
    p.candidate === undefined ? [] : [p.candidate.name],
  );
  if (named.length === 0) return undefined;
  const head = named.slice(0, 3).join(", ");
  return picks.length > 3 ? `${head}, +${picks.length - 3}` : head;
}

/**
 * Sonnet's answer to an Ask Sonnet turn (`places_show_picks`): the picks it
 * put on the Places map, as a numbered list (name, Google's type, why it
 * fits) beside a mini map of the same numbered pins — hovering either lifts
 * the other. The call carries only place ids; the names and positions are the
 * run's own Google candidates (`askCandidates`). Open by default: the picks
 * ARE the turn's answer.
 */
export function PicksToolView({ event }: ToolRendererProps) {
  const conversationId = useJsonlConversationId();
  const parsed = PlacesPicksSchema.safeParse(event.input);
  if (!parsed.success) {
    return (
      <ToolCallCard event={event} defaultOpen>
        <Text as="p" variant="caption" className="text-destructive">
          Unreadable picks: {parsed.error.message}
        </Text>
      </ToolCallCard>
    );
  }
  return (
    <LoadedPicks
      event={event}
      payload={parsed.data}
      conversationId={conversationId}
    />
  );
}

function LoadedPicks({
  event,
  payload,
  conversationId,
}: ToolRendererProps & {
  payload: PlacesPicks;
  conversationId: string | null;
}) {
  const candidates = useAskCandidates(conversationId);
  const errorText = event.result?.isError ? event.result.content : undefined;
  const count = payload.picks.length;
  const note = `· ${count} pick${count === 1 ? "" : "s"}`;

  let body: ReactNode;
  let summary: string | undefined;
  if (candidates.status === "loading") {
    body = <Loading variant="rows" count={2} />;
  } else if (candidates.status === "error") {
    body = (
      <ResourceErrorInline
        variant="block"
        subject="the picked places"
        error={candidates.error}
        refetch={candidates.refetch}
      />
    );
  } else {
    const picks = payload.picks.map((p, i): ShownPick => ({
      n: i + 1,
      placeId: p.googlePlaceId,
      why: p.why,
      candidate: candidates.data[p.googlePlaceId],
    }));
    summary = namesSummary(picks);
    body = <PicksBody picks={picks} />;
  }

  return (
    <ToolCallCard
      event={event}
      defaultOpen
      summary={summary}
      note={count === 0 ? "· no picks" : note}
    >
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mt-2 offsets the content from the card header */}
      <Stack gap="sm" className="mt-2">
        {errorText === undefined ? null : (
          <Text as="p" variant="caption" className="text-destructive">
            {errorText}
          </Text>
        )}
        {count === 0 ? null : body}
      </Stack>
    </ToolCallCard>
  );
}

function PicksBody({ picks }: { picks: readonly ShownPick[] }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const pins = useMemo(
    (): MapPin[] =>
      picks.flatMap((p) =>
        p.candidate === undefined
          ? []
          : [
              {
                kind: "pin",
                id: `${PIN_PREFIX}${p.placeId}`,
                position: { lat: p.candidate.lat, lng: p.candidate.lng },
                pinType: ASK_PICK_PIN_TYPE,
                label: p.candidate.name,
                data: { n: p.n },
              },
            ],
      ),
    [picks],
  );
  return (
    <Grid minCellWidth="16rem" mode="fit" gap="sm">
      <Stack as="ol" gap="none">
        {picks.map((p) => (
          <PickRow
            key={p.placeId}
            pick={p}
            highlighted={hovered === `${PIN_PREFIX}${p.placeId}`}
            onHover={setHovered}
          />
        ))}
      </Stack>
      {pins.length === 0 ? null : (
        <Surface
          level="raised"
          className={cn(clipClasses({ axis: "both", fill: false }), "min-h-56")}
        >
          <MapView
            overlays={pins}
            hoveredId={hovered}
            onHoverChange={setHovered}
            empty={null}
          />
        </Surface>
      )}
    </Grid>
  );
}

function PickRow({
  pick,
  highlighted,
  onHover,
}: {
  pick: ShownPick;
  highlighted: boolean;
  onHover: (id: string | null) => void;
}) {
  const { candidate } = pick;
  return (
    <li
      onMouseEnter={() => onHover(`${PIN_PREFIX}${pick.placeId}`)}
      onMouseLeave={() => onHover(null)}
      className={cn(
        "rounded-md px-xs py-2xs transition-colors",
        highlighted && "bg-hover-fill",
      )}
    >
      <Stack direction="row" gap="sm" align="start">
        <Center
          className={cn(
            rigidClass(),
            "size-5 rounded-full bg-primary text-primary-foreground",
          )}
        >
          <Text variant="count">{pick.n}</Text>
        </Center>
        <Stack gap="none" className={yieldClass("x")}>
          <Line className="gap-2xs">
            <Text variant="label" tone="strong">
              {candidate?.name ?? pick.placeId}
            </Text>
            {candidate?.category === undefined ? null : (
              <Text variant="label" tone="muted">
                · {candidate.category}
              </Text>
            )}
          </Line>
          <Text variant="caption" tone="muted">
            {pick.why}
          </Text>
        </Stack>
      </Stack>
    </li>
  );
}
