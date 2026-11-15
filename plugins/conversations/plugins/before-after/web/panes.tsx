import type { ReactNode } from "react";
import {
  Pane,
  PaneChrome,
  PaneIconAction,
  defineRoute,
  resolveRow,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { rowOrStale, useLive } from "@plugins/network/plugins/live/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { beforeAfterPairs, type BeforeAfterPair } from "../core";
import {
  CompareStateProvider,
  useCompareState,
} from "./internal/compare-state";
import { PairViewer } from "./components/pair-viewer";
import { PairGallery } from "./components/pair-gallery";
import { FullScreenCompare } from "./components/full-screen";

const fullScreenIcon = symbol("fullscreen");

/**
 * The pane is keyed by the PAIR, not a conversation satellite: a chip can open
 * it from anywhere (another conversation, a page). The pair's row names its
 * conversation, whose pairs the gallery lists.
 */
const beforeAfterRoute = defineRoute({
  id: "before-after",
  segment: "before-after/:pair",
});

/** The by-id read the guard, the title and the body share. */
function usePairRow(pair: string) {
  return useLive(beforeAfterPairs, { id: pair });
}

function useResolvePair({ pair }: { pair: string }): ResolveResult {
  return resolveRow(usePairRow(pair));
}

/**
 * One pair, large, over the gallery of every pair its conversation
 * registered: the Before / after pane. Opened beside the transcript by a
 * tool call's card, an Artifacts tile or a `ba-…` chip.
 */
export const beforeAfterPane = Pane.define({
  route: beforeAfterRoute,
  app: agentManagerApp,
  title: { useText: "Before / after", component: BeforeAfterTitle },
  useResolve: useResolvePair,
  component: BeforeAfterBody,
});

/** The conversation's pairs in the order they were registered — the gallery's and full screen's ← / →. */
function useConversationPairs(conversationId: string) {
  return useLive(beforeAfterPairs, {
    where: { conversationId },
    orderBy: [["createdAt", "asc"]],
  });
}

/** "Before / after" and how many pairs the pair's conversation has. */
function BeforeAfterTitle(): ReactNode {
  const { pair } = beforeAfterPane.useParams();
  const row = rowOrStale(usePairRow(pair));
  return (
    <Inline gap="sm" align="baseline">
      Before / after
      {row === undefined ? null : (
        <PairCount conversationId={row.conversationId} />
      )}
    </Inline>
  );
}

function PairCount({ conversationId }: { conversationId: string }): ReactNode {
  const pairs = useConversationPairs(conversationId);
  if (pairs.status !== "ready") return null;
  return (
    <Text tone="faint">
      {`${String(pairs.data.length)}${pairs.canGrow ? "+" : ""}`}
    </Text>
  );
}

/** The header's full-screen action: the pane's viewer over the whole window. */
function FullScreenAction(): ReactNode {
  const { setFullScreen } = useCompareState();
  return (
    <PaneIconAction
      label="Full screen"
      icon={fullScreenIcon}
      onClick={() => setFullScreen(true)}
    />
  );
}

function BeforeAfterBody(): ReactNode {
  return (
    <CompareStateProvider>
      <PaneChrome pane={beforeAfterPane}>
        <BeforeAfterContent />
      </PaneChrome>
    </CompareStateProvider>
  );
}

function BeforeAfterContent(): ReactNode {
  const { pair: pairId } = beforeAfterPane.useParams();
  // The guard answered found; `undefined` is only a first render.
  const pair = rowOrStale(usePairRow(pairId));
  if (pair === undefined) return <Loading variant="block" />;
  return <PairPane pair={pair} />;
}

function PairPane({ pair }: { pair: BeforeAfterPair }): ReactNode {
  const setParams = beforeAfterPane.useSetParams();
  const select = (id: string) => setParams({ pair: id });
  const { fullScreen } = useCompareState();
  const pairs = useConversationPairs(pair.conversationId);
  return (
    <Stack gap="none" className="h-full">
      <Fill axis="y" className="min-h-56">
        <Inset x="lg" t="md" b="md" className="size-full">
          <PairViewer pair={pair} className="size-full" />
        </Inset>
      </Fill>
      <div className="border-t border-border">
        <PairGallery
          conversationId={pair.conversationId}
          selectedId={pair.id}
          onSelect={select}
        />
      </div>
      {fullScreen ? (
        <FullScreenCompare
          pair={pair}
          // Until the conversation's pairs are read there is nothing to step
          // to: the one shown (the gallery under the pane says why if the
          // read failed).
          pairs={pairs.status === "ready" ? pairs.data : [pair]}
          onSelect={select}
        />
      ) : null}
    </Stack>
  );
}

/** The pane's header actions (contributed in the barrel). */
export const beforeAfterPaneActions = [
  beforeAfterPane.Actions({ id: "full-screen", component: FullScreenAction }),
];
