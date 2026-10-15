import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { clientLog } from "./client-log";
export {
  LiveLogChannel,
  type LiveLogChannelProps,
} from "./components/live-log-channel";

export default {
  description:
    "Persistent log-channel substrate: clientLog browser emitter that buffers and flushes log lines over plain HTTP to the per-worktree JSONL files. Server barrel owns Log/persist/registry and the /api/logs/emit + /ws/logs routes; debug/logs is the viewer.",
  loadBearing: true,
  contributions: [],
} satisfies PluginDefinition;
