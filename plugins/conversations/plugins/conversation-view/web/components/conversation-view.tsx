import { useEffect } from "react";
import { PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { useMarkConversationViewed } from "@plugins/conversations/plugins/hibernation/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import type { ResumeOutcome } from "@plugins/conversations/core";
import { ActionBarView } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { useConversationById } from "@plugins/conversations/web";
import { workspaceAllows } from "@plugins/conversations/plugins/workspace/core";
import { useAttemptWorkspaceKind } from "../use-attempt-workspace-kind";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { Conversation } from "../slots";
import { conversationPane } from "../panes";
import { PromptComposerProvider } from "../prompt-composer-context";
import { ActiveRelateSync } from "./active-relate-sync";
import { JsonlPane } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Bar } from "@plugins/primitives/plugins/bar/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

// Surface a refused transparent resume. Every other arm ("resumed", "nothing to
// resume") is the silent success this is supposed to be.
function reportBlockedResume(outcome: ResumeOutcome): void {
  if (outcome.kind !== "blocked") return;
  showToast({
    title: "Can't resume conversation",
    description: outcome.message,
    variant: "error",
  });
}

export function ConversationView() {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  const markConversationViewed = useMarkConversationViewed();

  // Selection signal for idle hibernation: opening (or switching to) a
  // conversation resets its idle timer and transparently resumes it if it was
  // hibernated. Fire-and-forget — failure here must not block rendering the
  // transcript (which renders from disk, independent of the live process).
  //
  // But it must not be SILENT either: when the resume is refused (its worktree
  // checkout was reclaimed while it slept) the transcript still renders
  // perfectly, so without this toast the only clue would be an agent that never
  // answers. The conversation's status is deliberately left alone by the server,
  // so it stays in the list and can be recovered.
  useEffect(() => {
    void markConversationViewed(convId).then(reportBlockedResume);
  }, [convId, markConversationViewed]);

  const promptBarItems = Conversation.PromptBar.useContributions();
  const promptInputItems = Conversation.PromptInput.useContributions();
  const abovePromptInputItems =
    Conversation.AbovePromptInput.useContributions();

  const showBottomBar =
    promptInputItems.length > 0 ||
    promptBarItems.length > 0 ||
    abovePromptInputItems.length > 0;

  if (!conversation) {
    return (
      <Center axis="both" className="h-full p-xl">
        <Loading />
      </Center>
    );
  }

  return (
    <ConversationBody
      conversation={conversation}
      showBottomBar={showBottomBar}
      hasPromptBar={promptBarItems.length > 0}
    />
  );
}

// The pane body for a loaded conversation. Every slot contribution states what
// the workspace must offer (`requires`) and renders only where it does.
function ConversationBody({
  conversation,
  showBottomBar,
  hasPromptBar,
}: {
  conversation: ConversationRecord;
  showBottomBar: boolean;
  hasPromptBar: boolean;
}) {
  const workspace = useAttemptWorkspaceKind(conversation.attemptId);
  return (
    <>
      <ActiveRelateSync />
      <PaneChrome pane={conversationPane}>
        <Clip fill as={Stack} className="h-full">
          {/* The toolbar strip under the header. Its glyphs and counters wear
              the palette's `toolbarForeground` (the inherited text colour by
              default), so a theme can quiet them without touching the labels'
              hover. */}
          <Bar tier="subpane" className="text-toolbar-foreground">
            <ActionBarView workspace={workspace} />
          </Bar>
          <Clip fill>
            {/* Around the transcript as well as the prompt: the transcript is
                where text gets picked to quote or answer INTO the prompt. */}
            <PromptComposerProvider>
              <JsonlPane conversation={conversation}>
                {showBottomBar && (
                  <>
                    {/* eslint-disable-next-line layout/no-adhoc-layout -- rigid bottom bar: must not shrink under the scrolling transcript above; lone shrink-0 block has no container primitive */}
                    <div className="shrink-0">
                      <Stack
                        gap="sm"
                        className="mx-auto max-w-reading px-md pt-xs pb-sm"
                      >
                        <Conversation.AbovePromptInput.Render>
                          {(item) =>
                            workspaceAllows(workspace, item.requires) ? (
                              <item.component conversation={conversation} />
                            ) : null
                          }
                        </Conversation.AbovePromptInput.Render>
                        <Conversation.PromptInput.Render>
                          {(item) =>
                            workspaceAllows(workspace, item.requires) ? (
                              <item.component conversation={conversation} />
                            ) : null
                          }
                        </Conversation.PromptInput.Render>
                        {hasPromptBar && (
                          // The footer under the prompt is a row of small pills:
                          // its own `xs` density, one step below the prompt's.
                          <ControlSizeProvider size="xs">
                            <Stack direction="row" gap="none" justify="end">
                              <Stack direction="row" gap="xs" align="center">
                                <Conversation.PromptBar.Render>
                                  {(item) => {
                                    if (
                                      !workspaceAllows(workspace, item.requires)
                                    ) {
                                      return null;
                                    }
                                    const Component = item.component;
                                    return (
                                      <Component conversation={conversation} />
                                    );
                                  }}
                                </Conversation.PromptBar.Render>
                              </Stack>
                            </Stack>
                          </ControlSizeProvider>
                        )}
                      </Stack>
                    </div>
                  </>
                )}
              </JsonlPane>
            </PromptComposerProvider>
          </Clip>
        </Clip>
      </PaneChrome>
    </>
  );
}
