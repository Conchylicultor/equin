import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { HookErrorView } from "./components/hook-error-view";

export default {
  collapsed: true,
  description:
    "Renders hook-failure attachment events (hook_non_blocking_error, hook_blocking_error, hook_cancelled, hook_stopped_continuation) as a destructive, expanded-by-default error card surfacing the failing command, exit code, stderr, and the guard message that stopped the agent.",
  contributions: [
    ...attachmentRenderer({
      match: "hook_non_blocking_error",
      component: HookErrorView,
      role: "conversation",
    }),
    ...attachmentRenderer({
      match: "hook_blocking_error",
      component: HookErrorView,
      role: "conversation",
    }),
    ...attachmentRenderer({
      match: "hook_cancelled",
      component: HookErrorView,
      role: "conversation",
    }),
    // A guard that stopped the agent mid-turn is a hook outcome the reader must
    // not miss, so it shares this plugin's loud chrome instead of inventing a
    // quieter one of its own.
    ...attachmentRenderer({
      match: "hook_stopped_continuation",
      component: HookErrorView,
      role: "conversation",
    }),
  ],
} satisfies PluginDefinition;
