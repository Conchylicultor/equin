import { z } from "zod";
import type { ToolCallEvent } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";

// Every field optional: the call may still be streaming in.
const InputSchema = z.object({
  url: z.string().optional(),
  prompt: z.string().optional(),
  offset: z.number().optional(),
});

export interface WebFetch {
  url?: string;
  prompt?: string;
  offset?: number;
}

export function readWebFetch(event: ToolCallEvent): WebFetch {
  return InputSchema.parse(event.input ?? {});
}

/** `host/path`, scheme, `www.` and a bare trailing slash dropped. A cut URL
 *  that does not parse yet is shown as written. */
export function compactUrl(url: string): string {
  if (!URL.canParse(url)) return url;
  const u = new URL(url);
  const path = u.pathname === "/" ? "" : u.pathname;
  return `${u.hostname.replace(/^www\./, "")}${path}${u.search}`;
}
