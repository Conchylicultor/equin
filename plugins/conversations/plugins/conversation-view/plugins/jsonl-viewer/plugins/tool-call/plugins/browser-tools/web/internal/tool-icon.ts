import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import type { ToolCall } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";

/** The glyph of a browser_* call's timeline node, by which browser tool it is. */
export function browserToolIcon(event: ToolCall): IconRef {
  const tool = event.name.replace(/^.*browser_/, "");
  switch (tool) {
    case "navigate":
      return symbol("language");
    case "screenshot":
      return symbol("photo-camera");
    case "javascript":
      return symbol("code");
    case "act":
      return symbol("mouse");
    case "find":
      return symbol("search");
    case "get_page_text":
    case "read_page":
      return symbol("article");
    case "console":
      return symbol("terminal");
    case "network":
      return symbol("lan");
    case "viewport":
      return symbol("aspect-ratio");
    case "tabs":
      return symbol("tab");
    case "batch":
      return symbol("list");
    case "close":
      return symbol("close");
    default:
      return symbol("web");
  }
}
