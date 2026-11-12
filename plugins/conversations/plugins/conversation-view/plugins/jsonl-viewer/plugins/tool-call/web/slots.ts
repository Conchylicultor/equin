import type { ComponentType } from "react";
import type { z } from "zod";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import {
  defineDispatchSlot,
  defineRenderSlot,
} from "@plugins/primitives/plugins/slot-render/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ToolCall, ToolCallEvent, ToolViewProps } from "../core";
import { GenericToolView } from "./components/generic-tool-view";
import { parsedToolView } from "./components/parsed-tool-view";

/** What the renderer slot hands the contribution it dispatches to: the call as the transcript holds it. */
export interface ToolCallProps {
  event: ToolCallEvent;
}

/**
 * The glyph on the call's timeline node, left of its name: what the tool does
 * at a glance (a terminal for Bash, a globe for a navigation). A renderer
 * covering several tools (a pattern match) passes a function of the call.
 * Absent: the generic tool glyph.
 */
export type ToolIcon = IconRef | ((event: ToolCall) => IconRef);

interface ToolRendererBase {
  /**
   * Plain string = exact tool name; RegExp = pattern; predicate = a test of
   * the call. Precedence: exact string → RegExp → predicate.
   */
  match: string | RegExp | ((props: ToolCallProps) => boolean);
  icon?: ToolIcon;
}

/**
 * A tool renderer: the schema its input is read with, and the component that
 * draws the call from the parsed input. The component never sees the raw
 * input — `event` carries everything but it — so it cannot draw from fields
 * the model did not write. A finished input that does not parse is drawn by
 * the generic card, showing the input as it is and what did not match.
 */
export interface ToolRendererSpec<I> extends ToolRendererBase {
  input: z.ZodType<I>;
  component: ComponentType<ToolViewProps<NoInfer<I>>>;
}

/**
 * A renderer that also draws a call the model is still writing: what is
 * written so far is read with `partialInput` (every field optional — a string
 * may stop mid-way), so the card fills in as it is written; until it parses,
 * the bare card. Once written, the input is read with `input` like any other
 * renderer's, and handed to the same component — so `I` must be a `P`.
 */
export interface PartialToolRendererSpec<
  I extends P,
  P,
> extends ToolRendererBase {
  input: z.ZodType<I>;
  partialInput: z.ZodType<P>;
  component: ComponentType<ToolViewProps<NoInfer<P>>>;
}

/** What the raw dispatch slot's contribution carries beside its component. */
export interface ToolRendererMeta {
  icon?: ToolIcon;
}

/**
 * The dispatch slot itself, private to this plugin: a contribution is made
 * only through `JsonlViewerTool.Renderer`, which pairs the component with the
 * schema its input is parsed with.
 */
export const ToolRendererSlot = defineDispatchSlot<
  ToolCallProps,
  string,
  ToolRendererMeta
>({
  key: (p) => p.event.name,
  fallback: GenericToolView,
  docLabel: (c) =>
    typeof c.match === "string"
      ? c.match
      : c.match instanceof RegExp
        ? c.match.source
        : undefined,
});

/** One tool renderer: contribute it under `JsonlViewerTool.Renderer`. */
function toolRenderer<I extends P, P>(
  spec: PartialToolRendererSpec<I, P>,
): Contribution;
function toolRenderer<I>(spec: ToolRendererSpec<I>): Contribution;
function toolRenderer<I extends P, P>(
  spec: ToolRendererSpec<I> | PartialToolRendererSpec<I, P>,
): Contribution {
  const partialInput = "partialInput" in spec ? spec.partialInput : undefined;
  return ToolRendererSlot({
    match: spec.match,
    icon: spec.icon,
    component: parsedToolView<I, P>({
      input: spec.input,
      partialInput,
      icon: spec.icon,
      component: spec.component as ComponentType<ToolViewProps<P>>,
    }),
  });
}

/**
 * A footer is not the call's renderer: it gets the raw call, and reads its
 * `input` as the `unknown` it is (`isRecordedToolCall` checks every field).
 */
export interface ToolFooterProps {
  event: ToolCallEvent;
}

/**
 * Rendered inside ANY tool call's card, under its header and always shown
 * (whichever renderer drew it, through `ToolCallCard`), for what the call left
 * behind beyond its result (e.g. the recording of the browser it drove). A
 * contribution decides for itself whether a call is one of its own and renders
 * nothing otherwise; it owns its top spacing, so nothing adds no gap.
 */
export interface ToolFooterContribution {
  id: string;
  component: ComponentType<ToolFooterProps>;
}

const ToolFooterSlot = defineRenderSlot<ToolFooterContribution>({
  docLabel: (p) => p.id,
});

/** The slots the plugin registers. */
export const JsonlViewerToolSlots = {
  Renderer: ToolRendererSlot,
  Footer: ToolFooterSlot,
};

/**
 * How other plugins contribute: `Renderer` is a typed factory over the
 * renderer slot (a schema is required), `Footer` the footer slot itself.
 */
export const JsonlViewerTool = {
  Renderer: toolRenderer,
  Footer: ToolFooterSlot,
};
