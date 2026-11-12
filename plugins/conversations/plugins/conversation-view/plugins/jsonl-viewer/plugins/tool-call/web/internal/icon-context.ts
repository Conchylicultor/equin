import { createContext } from "react";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ToolCall } from "../../core";

/**
 * The icon the renderer drawing a call declared (`JsonlViewerTool.Renderer`'s
 * `icon`), handed to the `ToolCallCard` it draws. Keyed by the call, like the
 * footer: a card drawn for another call inside this one's renderer (a nested
 * transcript) does not take it.
 */
export const ToolIconContext = createContext<
  | { toolUseId: string; icon: IconRef | ((event: ToolCall) => IconRef) }
  | undefined
>(undefined);
