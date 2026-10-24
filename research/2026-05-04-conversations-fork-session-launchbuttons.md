# fork-session: eliminate hand-rolled fetch via useLaunchConversation hook

## Context

`ForkSessionAction` and `ForkConversationAction` hand-roll the same fetch/state/parse/open cycle that `LaunchButtons` already encapsulates — including missing the error-handling path on non-ok responses. The correct fix is to extract the behavior into a `useLaunchConversation` hook and use it in the row-action components, keeping the `RowActionButton` UI intact.

`ForkSessionAction` lives in `JsonlViewer.RowAction` — the hover-reveal strip at the top-right of each event row, shared with copy and markdown-toggle. Moving it to `Conversation.PromptBar` (toolbar) would lose that contextual placement for no gain.

Two dead files also need to go:
- `fork-conversation-action.tsx` — never registered, replaced by `ForkConversationButtons` in `Conversation.PromptBar`
- `fork-session-buttons.tsx` — never registered, an aborted alternative approach

## Changes

### 1. Add `useLaunchConversation` to `plugins/primitives/plugins/launch/web/components/launch-buttons.tsx`

Extract the stateful fetch logic out of `LaunchButtons` into a named hook in the same file:

```ts
export function useLaunchConversation({
  getRequest,
  openAfterLaunch = true,
  onLaunched,
}: Pick<LaunchButtonsProps, "getRequest" | "openAfterLaunch" | "onLaunched">) {
  const [launching, setLaunching] = useState<ConversationModel | null>(null);

  const launch = async (e: React.MouseEvent, model: ConversationModel) => {
    e.stopPropagation();
    if (launching) return;
    setLaunching(model);
    try {
      const request = (await getRequest?.()) ?? {};
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, ...request }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `Launch failed (${res.status}${res.statusText ? ` ${res.statusText}` : ""})${
            detail ? `: ${detail.slice(0, 200)}` : ""
          }`,
        );
      }
      const conversation = ConversationSchema.parse(await res.json());
      onLaunched?.(conversation);
      if (openAfterLaunch) conversationPane.open({ convId: conversation.id });
    } finally {
      setLaunching(null);
    }
  };

  return { launch, launching };
}
```

`LaunchButtons` delegates to it internally (no behaviour change). Export `useLaunchConversation` from `launch/web/index.ts`.

### 2. Refactor `fork-session/web/components/fork-session-action.tsx`

Replace the hand-rolled state/fetch with the hook:

```tsx
import { MdPlayArrow } from "react-icons/md";
import type { JsonlEvent } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/shared";
import {
  useLastAssistantEvent,
  RowActionButton,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useLaunchConversation } from "@plugins/primitives/plugins/launch/web";
import type { ConversationModel } from "@plugins/conversations/shared";

const MODELS: ConversationModel[] = ["sonnet", "opus"];
const ICON_SIZE: Record<ConversationModel, string> = { sonnet: "size-2.5", opus: "size-3.5" };

export function ForkSessionAction({ event }: { event: JsonlEvent }) {
  const lastAssistant = useLastAssistantEvent();
  const { conversation } = conversationPane.useData();
  const { launch, launching } = useLaunchConversation({
    getRequest: () => ({ forkFromConversationId: conversation.id }),
  });

  if (event !== lastAssistant || !conversation.claudeSessionId) return null;

  return (
    <>
      {MODELS.map((model) => (
        <RowActionButton
          key={model}
          title={`Fork session → ${model}`}
          disabled={!!launching}
          onClick={(e) => launch(e, model)}
        >
          <MdPlayArrow className={ICON_SIZE[model]} />
        </RowActionButton>
      ))}
    </>
  );
}
```

Eliminates: `useState`, `fetch`, `ConversationSchema.parse`, `conversationPane.open`, missing error handling.

### 3. Delete dead files

- `fork-session/web/components/fork-session-buttons.tsx` — never registered, aborted alternative
- `fork-conversation/web/components/fork-conversation-action.tsx` — never registered, superseded by `ForkConversationButtons`

## Critical files

| File | Change |
|---|---|
| `plugins/primitives/plugins/launch/web/components/launch-buttons.tsx` | Extract hook, `LaunchButtons` delegates to it |
| `plugins/primitives/plugins/launch/web/index.ts` | Export `useLaunchConversation` |
| `plugins/conversations/plugins/conversation-view/plugins/fork-session/web/components/fork-session-action.tsx` | Use hook |
| `plugins/conversations/plugins/conversation-view/plugins/fork-session/web/components/fork-session-buttons.tsx` | **Delete** |
| `plugins/conversations/plugins/conversation-view/plugins/fork-conversation/web/components/fork-conversation-action.tsx` | **Delete** |

## Verification

1. `./equin build` — zero errors; CLAUDE.md autogen updates to reflect `useLaunchConversation` export from `launch`.
2. Hover over the last assistant message — the row-action strip shows the fork-session buttons (MdPlayArrow × 2) next to copy and markdown-toggle, unchanged visually.
3. Click a fork-session button — new conversation opens in the pane. Non-ok responses now surface an error rather than silently doing nothing.
