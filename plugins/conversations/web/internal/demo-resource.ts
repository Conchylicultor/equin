import type {
  BrowserServe,
  BrowserServed,
} from "@plugins/framework/plugins/browser-server/core";
import { conversationPartialMessage } from "../../core";

/**
 * The streaming message inside a demo scope (`Demo.Resource`): none — no agent
 * runs in the demo, its conversations are finished transcripts. Module-level,
 * so the serve function is stable.
 */
export function serveDemoPartialMessage(
  s: BrowserServe,
): readonly BrowserServed[] {
  return [
    s.serveValue(conversationPartialMessage, {
      source: "external",
      changes: { fixed: { reason: "no agent runs in the demo" } },
      loader: () => null,
    }),
  ];
}
