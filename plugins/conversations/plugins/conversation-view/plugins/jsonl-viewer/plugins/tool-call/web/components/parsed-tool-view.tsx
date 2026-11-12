import { useEffect, useMemo, type ComponentType, type ReactNode } from "react";
import type { z } from "zod";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { useBlockWriting } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import {
  inputSummary,
  readToolInput,
  type ToolCall,
  type ToolCallEvent,
  type ToolViewProps,
} from "../../core";
import { ToolIconContext } from "../internal/icon-context";
import { emitToolInputDrift } from "../internal/input-drift";
import { ToolCallCard } from "./tool-call-card";
import { GenericToolView } from "./generic-tool-view";

interface ParsedToolViewSpec<I extends P, P> {
  input: z.ZodType<I>;
  partialInput: z.ZodType<P> | undefined;
  icon: IconRef | ((event: ToolCall) => IconRef) | undefined;
  component: ComponentType<ToolViewProps<P>>;
}

/**
 * The component a tool renderer is dispatched as: reads the call's input
 * with the renderer's schemas and hands its component the parsed input and
 * the call without its raw input — or, when the input does not read, draws
 * the bare card (still being written) or the generic card (a finished input
 * the renderer does not draw: the model got the call wrong, or the tool's
 * input changed since).
 */
export function parsedToolView<I extends P, P>(
  spec: ParsedToolViewSpec<I, P>,
): ComponentType<{ event: ToolCallEvent }> {
  const { component: View } = spec;
  function ParsedToolView({ event }: { event: ToolCallEvent }) {
    const writing = useBlockWriting();
    const read = useMemo(
      () =>
        readToolInput(
          event.input,
          { input: spec.input, partialInput: spec.partialInput },
          writing,
        ),
      [event.input, writing],
    );
    const call = useMemo((): ToolCall => {
      const { input: _raw, ...rest } = event;
      return rest;
    }, [event]);
    const icon = useMemo(
      () =>
        spec.icon === undefined
          ? undefined
          : { toolUseId: event.toolUseId, icon: spec.icon },
      [event.toolUseId],
    );
    // The tool took an input the renderer's schema rejects: the schema is
    // wrong, not the call — reported, since the generic card alone is quiet.
    const accepted =
      event.result !== undefined &&
      !event.result.isError &&
      !event.result.outcomeUnknown;
    const drift = read.kind === "invalid" && accepted ? read.issues : undefined;
    useEffect(() => {
      if (drift === undefined) return;
      emitToolInputDrift({
        tool: event.name,
        toolUseId: event.toolUseId,
        issues: drift,
      });
    }, [drift, event.name, event.toolUseId]);
    let body: ReactNode;
    switch (read.kind) {
      case "ready":
        body = <View event={call} input={read.input} />;
        break;
      case "writing":
        body = (
          <ToolCallCard event={call} summary={inputSummary(event.input)} />
        );
        break;
      case "invalid":
        body = <GenericToolView event={event} mismatch={read.issues} />;
        break;
    }
    return <ToolIconContext value={icon}>{body}</ToolIconContext>;
  }
  ParsedToolView.displayName = `Parsed(${View.displayName ?? View.name})`;
  return ParsedToolView;
}
