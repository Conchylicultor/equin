import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { LaunchControl } from "@plugins/primitives/plugins/launch/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { plainOf } from "@plugins/page/plugins/editor/core";
import type { BlockRegionProps } from "@plugins/page/plugins/editor/web";
import { createPromptTask } from "@plugins/page/plugins/prompt/plugins/link/web";
import { promptBlock } from "../../core";
import { LaunchedConversations } from "./launched-conversations";

/**
 * The prompt block's action row, contributed as `chrome.regions.footer` — the
 * block-after region, a full-box-width row below the editable line: the launch
 * control plus the conversations this block has already launched.
 *
 * ## Nothing renders on a read-only surface, for two independent reasons
 *
 * `editor` is absent exactly on the read-only surfaces (version-history preview,
 * the public site), and this region returns `null` there rather than degrading
 * to a static rendering, because:
 *
 * 1. Its content is **live agent state, not document content.** A
 *    version-history preview of last Tuesday showing today's conversation chips
 *    would be a lie about the snapshot.
 * 2. It would **crash, not degrade.** Each chip `LaunchedConversations` renders
 *    is a `ConversationChip`, which calls `useOpenPane` /
 *    `conversationPane.useRouteEntries()` — neither of which exists on the
 *    public-site surface.
 *
 * The marker (`chrome.regions.start`) does render there — so a prompt still
 * looks like a prompt in a snapshot, it just cannot be launched from one.
 */
export function PromptFooter({ id, pageId, data, editor }: BlockRegionProps) {
  const fetchEndpoint = useFetchEndpoint();
  if (!editor) return null;

  // What the user SEES rendered. The launch sends this, never the server's own
  // copy: `data.text` is the block row's projection of the CRDT doc and lags it
  // by ~1s, so a launch right after typing would otherwise stamp stale text.
  // (It lags here too — the button stays disabled for that beat on a brand-new
  // block — but it can never send text the user didn't see.)
  //
  // Read DEFENSIVELY, as `BlockRegionProps.data` says to and as `CalloutAnchor`
  // / `CalloutFrame` already do: a region's `data` is the raw row blob and may
  // be transient mid-edit. An unparseable payload degrades to no prompt text,
  // which is already a state this control handles — the launch button is inert.
  const parsed = promptBlock.safeParse(data);
  const prompt = parsed.success ? plainOf(parsed.data.text).trim() : "";

  return (
    // The action row pads itself rather than the box, so the box's first line
    // stays exactly where `gutterFirstLineCenter` says it is.
    <Inset x="xs" b="xs">
      <ControlSizeProvider size="sm">
        <Line>
          <LaunchControl
            size="icon"
            openMode="push"
            // An empty prompt would create a task with no description, so the
            // control is inert until there is something to ask.
            disabled={prompt.length === 0}
            getRequest={async () => {
              if (prompt.length === 0) {
                throw new Error("Prompt block launched with empty text");
              }
              if (!pageId) {
                throw new Error(
                  `Prompt block ${id} has no page — cannot stamp provenance`,
                );
              }
              const { taskId } = await createPromptTask(fetchEndpoint, {
                pageId,
                blockId: id,
                prompt,
              });
              return { taskId, prompt };
            }}
          />
          <Fill>
            <LaunchedConversations blockId={id} />
          </Fill>
        </Line>
      </ControlSizeProvider>
    </Inset>
  );
}
