import type { ComponentType } from "react";
import {
  defineDispatchSlot,
  defineRenderSlot,
  type DispatchContribution,
} from "@plugins/primitives/plugins/slot-render/web";
import type { ToolCallEvent, ToolRendererProps } from "../core";
import { GenericToolView } from "./components/generic-tool-view";

export type ToolRendererContribution = DispatchContribution<
  ToolRendererProps,
  string
>;

export interface ToolFooterProps {
  event: ToolCallEvent;
}

/**
 * Rendered under ANY tool call's card, whichever renderer drew it, for what
 * the call left behind beyond its result (e.g. the recording of the browser it
 * drove). A contribution decides for itself whether a call is one of its own
 * and renders nothing otherwise.
 */
export interface ToolFooterContribution {
  id: string;
  component: ComponentType<ToolFooterProps>;
}

export const JsonlViewerTool = {
  Renderer: defineDispatchSlot<ToolRendererProps, string>({
    key: (p) => p.event.name,
    fallback: GenericToolView,
    docLabel: (c) =>
      typeof c.match === "string"
        ? c.match
        : c.match instanceof RegExp
          ? c.match.source
          : undefined,
  }),
  Footer: defineRenderSlot<ToolFooterContribution>({ docLabel: (p) => p.id }),
};
