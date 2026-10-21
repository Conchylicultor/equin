import type { ReactNode } from "react";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { MapBounds } from "@plugins/map/core";
import { AgentThread } from "@plugins/conversations/plugins/agent-thread/web";
import {
  placesPicks,
  type PlacesPicks,
} from "@plugins/apps/plugins/places/plugins/ask/core";
import type {
  Place,
  PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { picksOf, useAskCandidates } from "../internal/ask-picks";
import { GoogleResultCard, type GoogleHit } from "./google-result-card";

const sonnetIcon = symbol("auto-awesome");
const closeIcon = symbol("close");

const RESULTS = [placesPicks];

/** The thread's height inside the search panel: room for a turn and its cards. */
const THREAD_HEIGHT = "min(36rem, 70vh)";

export interface AskThreadPanelProps {
  conversationId: string;
  tags: readonly PlaceTag[];
  bounds: MapBounds | null;
  savedByGoogleId: ReadonlyMap<string, Place>;
  hoveredGoogleId: string | null;
  onHoverGoogle: (placeId: string | null) => void;
  onSave: (hit: GoogleHit) => Promise<void>;
  onOpenPlace: (place: Place) => void;
  /** Back to the search (the run goes on in the Agent Manager). */
  onClose: () => void;
}

/**
 * Ask Sonnet's run, in the search panel: the conversation as a thread (your
 * question, Sonnet's steps, its answer), each turn's picks as Google cards
 * with why they fit — Save on each — and a reply box to refine. Older turns'
 * picks shrink to their names.
 */
export function AskThreadPanel(props: AskThreadPanelProps) {
  const { conversationId, onClose } = props;
  return (
    <div style={{ height: THREAD_HEIGHT }}>
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
          <IconButton
            icon={closeIcon}
            label="Back to search"
            onClick={onClose}
          />
        }
        placeholder="Reply to Sonnet — e.g. cheaper, open late"
        renderResult={(result, { latest }) => (
          <Picks {...props} payload={result.payload} latest={latest} />
        )}
      />
    </div>
  );
}

function Picks({
  conversationId,
  tags,
  bounds,
  savedByGoogleId,
  hoveredGoogleId,
  onHoverGoogle,
  onSave,
  onOpenPlace,
  payload,
  latest,
}: AskThreadPanelProps & { payload: PlacesPicks; latest: boolean }): ReactNode {
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
  if (!latest) {
    // An earlier answer: its picks by name, struck — the map shows the newest.
    return (
      <Cluster gap="sm">
        {picks.map((p) => (
          <Text
            key={p.hit.placeId}
            variant="caption"
            tone="muted"
            className="line-through"
          >
            {p.hit.name}
          </Text>
        ))}
      </Cluster>
    );
  }
  return (
    <Stack gap="2xs">
      {picks.map((p) => {
        const saved = savedByGoogleId.get(p.hit.placeId);
        return (
          <GoogleResultCard
            key={p.hit.placeId}
            hit={p.hit}
            pick={{ n: p.n, why: p.why }}
            highlighted={p.hit.placeId === hoveredGoogleId}
            onHover={onHoverGoogle}
            saved={saved !== undefined}
            onSave={() => onSave(p.hit)}
            onOpenSaved={() => {
              if (saved !== undefined) onOpenPlace(saved);
            }}
          />
        );
      })}
    </Stack>
  );
}
