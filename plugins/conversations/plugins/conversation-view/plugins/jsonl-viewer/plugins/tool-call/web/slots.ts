import type { ComponentType } from "react";
import {
  defineDispatchSlot,
  defineRenderSlot,
  type DispatchContribution,
} from "@plugins/primitives/plugins/slot-render/web";
import type { ToolCallEvent, ToolRendererProps } from "../core";
import { GenericToolView } from "./components/generic-tool-view";

/**
 * `partialInput`: the renderer draws a call whose input is still being written
 * — any field may be missing, a string may stop mid-way — so the call's card
 * fills in as the model writes it. A renderer without it is only handed a
 * finished input; until then the call shows as its header alone.
 */
export interface ToolRendererMeta {
  partialInput?: true;
}

export type ToolRendererContribution = DispatchContribution<
  ToolRendererProps,
  string
> &
  ToolRendererMeta;

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
  Renderer: defineDispatchSlot<ToolRendererProps, string, ToolRendererMeta>({
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
