import type { ReactNode } from "react";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { FoldMotion } from "@plugins/primitives/plugins/collapsible/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { MapBounds } from "@plugins/map/core";
import {
  AgentThread,
  EndThreadButton,
} from "@plugins/conversations/plugins/agent-thread/web";
import {
  placesPicks,
  type PlacesPicks,
} from "@plugins/apps/plugins/places/plugins/ask/core";
import type {
  Place,
  PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  picksOf,
  useAskCandidates,
  useAskResults,
  type AskPick,
} from "../internal/ask-picks";
import { GoogleResultCard, type GoogleHit } from "./google-result-card";

const sonnetIcon = symbol("auto-awesome");
const hideIcon = symbol("right-panel-close");
const expandIcon = symbol("chevron-right");
const collapseIcon = symbol("expand-more");

const RESULTS = [placesPicks];

/** The docked card's width — the screen also reads it, to keep pins and cards out from under it. */
export const ASK_THREAD_WIDTH = "380px";

/** Names an earlier result's summary line lists before "…". */
const SUMMARY_NAMES = 3;

export interface AskThreadCardProps {
  conversationId: string;
  tags: readonly PlaceTag[];
  bounds: MapBounds | null;
  savedByGoogleId: ReadonlyMap<string, Place>;
  hoveredGoogleId: string | null;
  onHoverGoogle: (placeId: string | null) => void;
  onSave: (hit: GoogleHit) => Promise<void>;
  /** Open a pick's detail card (a saved one: its place card). */
  onOpenPick: (pick: AskPick) => void;
  /** Earlier results unfolded to their cards (and their pins), by call id. */
  expanded: ReadonlySet<string>;
  onToggleExpanded: (toolUseId: string) => void;
  /** Collapse the card to its pill; the run goes on. */
  onHide: () => void;
  /** The run was ended (Done). */
  onEnded: () => void;
}

/**
 * Ask Sonnet's run, docked on the right of the map as a full-height card: the
 * conversation as a thread (your question, Sonnet's steps, its answer), a
 * reply box to refine, and in the header Done (closes the conversation and
 * drops its task — it stays in the history, and can be reopened and replied
 * to) and Hide (back to the pill). The CURRENT result — the newest picks,
 * whichever turn gave them — shows as cards (photo, rank, why, about,
 * sources, Save; a click opens the pick's detail card); each earlier one is a
 * one-line summary that unfolds to its cards, and its pins join the map's
 * while unfolded.
 */
export function AskThreadCard(props: AskThreadCardProps) {
  const { conversationId, onHide, onEnded } = props;
  const results = useAskResults(conversationId);
  const currentId =
    results.status === "ready"
      ? (results.data.at(-1)?.toolUseId ?? null)
      : null;
  return (
    <Surface
      level="overlay"
      className={cn(
        "pointer-events-auto h-full",
        clipClasses({ axis: "both", fill: false }),
      )}
      style={{ width: ASK_THREAD_WIDTH }}
    >
      <AgentThread
        conversationId={conversationId}
        results={RESULTS}
        title={
          <Line className="gap-2xs text-primary-text">
            <Icon icon={sonnetIcon} className="size-4" />
            <Text variant="label" tone="strong">
              Sonnet
            </Text>
          </Line>
        }
        resultWords={(n) => `${n} pick${n === 1 ? "" : "s"}`}
        headerAction={
          <>
            <EndThreadButton
              conversationId={conversationId}
              onEnded={onEnded}
            />
            <IconButton icon={hideIcon} label="Hide" onClick={onHide} />
          </>
        }
        placeholder="Reply to Sonnet — e.g. cheaper, open late"
        renderResult={(result) => (
          <Picks
            {...props}
            toolUseId={result.toolUseId}
            payload={result.payload}
            current={result.toolUseId === currentId}
          />
        )}
      />
    </Surface>
  );
}

function Picks(
  props: AskThreadCardProps & {
    toolUseId: string;
    payload: PlacesPicks;
    current: boolean;
  },
): ReactNode {
  const {
    conversationId,
    tags,
    bounds,
    toolUseId,
    payload,
    current,
    expanded,
    onToggleExpanded,
  } = props;
  const candidates = useAskCandidates(conversationId);
  if (candidates.status === "loading")
    return <Loading variant="rows" count={2} />;
  if (candidates.status === "error")
    return (
      <ResourceErrorInline
        variant="block"
        subject="Sonnet's picks"
        error={candidates.error}
        refetch={candidates.refetch}
      />
    );
  const picks = picksOf(payload, candidates.data, bounds, tags);
  if (picks.length === 0) {
    return (
      <Text as="div" variant="caption" tone="muted">
        Nothing matched.
      </Text>
    );
  }
  if (current) return <PickCards {...props} picks={picks} />;
  // An earlier answer: one line, unfolding to its cards (and its pins).
  const open = expanded.has(toolUseId);
  const names = picks.slice(0, SUMMARY_NAMES).map((p) => p.hit.name);
  return (
    <Stack gap="2xs">
      <Line
        as="button"
        type="button"
        aria-expanded={open}
        onClick={() => onToggleExpanded(toolUseId)}
        className="w-full gap-xs rounded-md border px-sm py-xs text-left text-muted-foreground hover:bg-hover-fill"
      >
        <Icon icon={open ? collapseIcon : expandIcon} className="size-4" />
        <Fill>
          <Text variant="caption" tone="muted">
            {`${picks.length} pick${picks.length === 1 ? "" : "s"} · ${names.join(", ")}${picks.length > SUMMARY_NAMES ? "…" : ""}`}
          </Text>
        </Fill>
        <Text variant="caption" tone="muted">
          {open ? "Hide" : "Show"}
        </Text>
      </Line>
      <FoldMotion open={open}>
        <PickCards {...props} picks={picks} />
      </FoldMotion>
    </Stack>
  );
}

function PickCards({
  picks,
  savedByGoogleId,
  hoveredGoogleId,
  onHoverGoogle,
  onSave,
  onOpenPick,
}: AskThreadCardProps & { picks: readonly AskPick[] }): ReactNode {
  return (
    <Stack gap="2xs">
      {picks.map((p) => {
        const saved = savedByGoogleId.get(p.hit.placeId);
        return (
          <GoogleResultCard
            key={p.hit.placeId}
            hit={p.hit}
            pick={p}
            highlighted={p.hit.placeId === hoveredGoogleId}
            onHover={onHoverGoogle}
            saved={saved !== undefined}
            onSave={() => onSave(p.hit)}
            onOpenSaved={() => onOpenPick(p)}
            onOpen={() => onOpenPick(p)}
          />
        );
      })}
    </Stack>
  );
}
