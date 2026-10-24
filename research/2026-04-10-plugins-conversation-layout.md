# Conversation Layout Plugin

## Context

The app needs a composite "conversation" pane that wraps a Claude terminal session with an extensible toolbar. This enables other plugins to contribute conversation-specific actions (restart, export, etc.) while the conversation plugin handles the layout composition. Consumers open it via `Shell.OpenPane(conversationPane({ session_id: "..." }))`.

The `claude-sessions` plugin (`plugins/claude-sessions/`) already manages tmux-based Claude sessions (list, create, delete) and opens them via `terminalPane({ command: [TMUX, "-u", "attach", "-t", name] })`. The conversation plugin will sit between `claude-sessions` and `terminalPane` — `claude-sessions` will open `conversationPane(...)` instead of `terminalPane(...)` directly.

## Plan

### New files

**`plugins/conversation/package.json`**
```json
{
  "name": "@singularity/plugin-conversation",
  "private": true,
  "version": "0.0.1"
}
```

**`plugins/conversation/web/slots.ts`** — Public slot for other plugins to contribute toolbar items:
```ts
import { defineSlot } from "@core";
import type { ComponentType } from "react";

export interface ConversationState {
  id: string;
}

export const Conversation = {
  Toolbar: defineSlot<{
    label: string;
    icon: ComponentType<{ className?: string }>;
    onClick: (conversation: ConversationState) => void;
  }>("conversation.toolbar"),
};
```

`onClick` receives a structured `ConversationState` object (currently just `{ id }`, extensible later with status, metadata, etc.) rather than a bare string.

**`plugins/conversation/web/views.tsx`** — View factory (public API):
```tsx
import type { PaneDescriptor } from "@plugins/shell/web/commands";
import { ConversationView } from "./components/conversation-view";

export function conversationPane(opts: { session_id: string }): PaneDescriptor {
  const Component = () => <ConversationView sessionId={opts.session_id} />;
  return {
    title: opts.session_id,
    component: Component,
  };
}
```

**`plugins/conversation/web/components/conversation-view.tsx`** — Internal composite component:
```tsx
import { Conversation } from "../slots";
import type { ConversationState } from "../slots";
import { terminalPane } from "@plugins/terminal/web/views";
import { Button } from "@/components/ui/button";

const TMUX = "/opt/homebrew/bin/tmux";

export function ConversationView({ sessionId }: { sessionId: string }) {
  const toolbarItems = Conversation.Toolbar.useContributions();
  const conversation: ConversationState = { id: sessionId };

  const { component: TerminalComponent } = terminalPane({
    command: [TMUX, "-u", "attach", "-t", sessionId],
    title: sessionId,
  });

  return (
    <div className="flex h-full flex-col">
      {toolbarItems.length > 0 && (
        <div className="flex items-center gap-1 border-b px-4 h-10">
          {toolbarItems.map((item) => (
            <Button key={item.label} variant="ghost" size="sm"
              onClick={() => item.onClick(conversation)}>
              <item.icon className="size-4" />
              {item.label}
            </Button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        <TerminalComponent />
      </div>
    </div>
  );
}
```

No memoization needed — the terminal runs in tmux, so re-creating the xterm instance just reattaches to the same tmux session.

**`plugins/conversation/web/index.ts`** — Plugin definition (no static contributions):
```ts
import type { PluginDefinition } from "@core";

const conversationPlugin: PluginDefinition = {
  id: "conversation",
  name: "Conversation",
};
export default conversationPlugin;
```

### Modified files

**`web/src/plugins.ts`** — Register the plugin:
```ts
import conversationPlugin from "@plugins/conversation/web";
// Add to plugins array
```

**`plugins/claude-sessions/web/components/session-list.tsx`** — Change `openSession` to use `conversationPane` instead of `terminalPane` directly:
```ts
// Before:
import { terminalPane } from "@plugins/terminal/web/views";
Shell.OpenPane(terminalPane({ command: [TMUX, "-u", "attach", "-t", name], title: name }));

// After:
import { conversationPane } from "@plugins/conversation/web/views";
Shell.OpenPane(conversationPane({ session_id: name }));
```

The tmux attach command moves inside `ConversationView`, so `session-list.tsx` no longer needs to know about tmux details.

### Usage

Opening a conversation:
```ts
Shell.OpenPane(conversationPane({ session_id: "abc-123" }))
```

Contributing a toolbar button:
```ts
Conversation.Toolbar({
  label: "Restart",
  icon: MdRefresh,
  onClick: (conversation) => fetch(`/api/sessions/${conversation.id}/restart`, { method: "POST" }),
})
```

## Verification

1. `bun install` from root
2. `./equin build`
3. Open a Claude session from the sidebar — should see the terminal with conversation toolbar area
4. Verify the tmux session reattaches correctly on pane re-render
