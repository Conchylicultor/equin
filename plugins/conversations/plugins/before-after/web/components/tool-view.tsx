import type { ReactNode } from "react";
import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import {
  ToolCallCard,
  ToolOutput,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { SwipeCompare } from "@plugins/primitives/plugins/diff-view/plugins/swipe-compare/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { beforeAfterPairs, type BeforeAfterPair } from "../../core";
import { beforeAfterPane } from "../panes";
import { AfterImage, BeforeImage, PairNote } from "./pair-image";
import { PairIdChip } from "./pair-id-chip";

const openInPaneIcon = navIcons.sidePane;

/**
 * `register_before_after`'s input as the card draws it — only what the header
 * names. Not the tool's own schema: a transcript keeps whatever the agent
 * sent, and the card draws the pair the call registered, read back by its
 * tool-use id, never the input.
 */
export const RegisterBeforeAfterViewSchema = z.looseObject({
  title: z.string(),
  route: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});
type RegisterBeforeAfterView = z.infer<typeof RegisterBeforeAfterViewSchema>;

/** What the call compares, as the header's summary: its route and size. */
function callSummary(input: RegisterBeforeAfterView): string {
  const size =
    input.width !== undefined && input.height !== undefined
      ? `${String(input.width)} × ${String(input.height)}`
      : undefined;
  return [input.route ?? input.title, size]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

/**
 * A `register_before_after` call: the tool row, then — once the call answered
 * — the pair it registered as a swipe preview under it (title, route, its id
 * chip, Open in pane, and a compact swipe). A failed call is the plain card
 * with the tool's error, the way the generic view draws it.
 */
export function RegisterBeforeAfterToolView({
  event,
  input,
}: ToolViewProps<RegisterBeforeAfterView>): ReactNode {
  const succeeded = event.result !== undefined && !event.result.isError;
  return (
    <ToolCallCard
      event={event}
      summary={callSummary(input)}
      footer={
        succeeded ? <PairPreviewOf toolUseId={event.toolUseId} /> : undefined
      }
    >
      <ToolOutput event={event} />
    </ToolCallCard>
  );
}

/** The pair a call registered, read by its tool-use id. */
function PairPreviewOf({ toolUseId }: { toolUseId: string }): ReactNode {
  const result = useLive(beforeAfterPairs, { where: { toolUseId }, limit: 1 });
  if (result.status === "loading")
    return (
      <PreviewFrame>
        <Loading variant="block" />
      </PreviewFrame>
    );
  if (result.status === "error")
    return (
      <PreviewFrame>
        <ResourceErrorInline
          variant="inline"
          subject="the before / after pair"
          error={result.error}
          refetch={result.refetch}
        />
      </PreviewFrame>
    );
  const pair = result.data[0];
  if (pair === undefined)
    return (
      <PreviewFrame>
        <PairNote>
          The call answered, but no pair is recorded under it — it was deleted,
          or registered in another database.
        </PairNote>
      </PreviewFrame>
    );
  return <PairPreview pair={pair} />;
}

/**
 * The tallest the preview's box gets, as width / height: a landscape box. A
 * taller pair (a full-page capture) is shown whole inside it, shrunk to its
 * height — the pane zooms into it.
 */
const PREVIEW_MIN_ASPECT = 16 / 10;

/** The preview card's box: a raised card under the tool row, as wide as the transcript. */
function PreviewFrame({ children }: { children: ReactNode }): ReactNode {
  return (
    <Surface level="raised" className="w-full p-sm">
      <Stack gap="sm">{children}</Stack>
    </Surface>
  );
}

function PairPreview({ pair }: { pair: BeforeAfterPair }): ReactNode {
  const openPane = useOpenPane();
  // `push`: the pane opens as a column to the RIGHT of the conversation, so
  // the transcript stays beside it.
  const open = openPane.to(
    beforeAfterPane,
    { pair: pair.id },
    { mode: "push" },
  );
  const boxAspect = Math.max(pair.width / pair.height, PREVIEW_MIN_ASPECT);
  return (
    <PreviewFrame>
      <ControlSizeProvider size="xs">
        <Line gap="sm">
          <Fill>
            <Text variant="label">
              {pair.title}{" "}
              {pair.route === null ? null : (
                <Text tone="muted" variant="caption">
                  {pair.route}
                </Text>
              )}
            </Text>
          </Fill>
          <PairIdChip id={pair.id} activation={open} tooltip="Open in pane" />
          <IconButton
            icon={openInPaneIcon}
            label="Open in pane"
            {...activationProps(open, { isolate: true })}
          />
        </Line>
      </ControlSizeProvider>
      <div className="w-full" style={{ aspectRatio: String(boxAspect) }}>
        <SwipeCompare
          before={<BeforeImage pair={pair} />}
          after={<AfterImage pair={pair} />}
          mode="swipe"
          aspect={pair.width / pair.height}
        />
      </div>
    </PreviewFrame>
  );
}
