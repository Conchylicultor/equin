import type { ReactElement } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  PrototypeDetailProvider,
  decodeCanvas,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { prototypePresentCanvasPane } from "../panes";
import { CanvasStage } from "./canvas-stage";
import { PresentBox } from "./present-box";
import { LeaveToCanvasButton } from "./present-stage";

/**
 * The canvas as a page of its own (a chromeless new browser tab): the same
 * canvas the pane showed when it was opened — frames, versions, picks, size,
 * zoom, layout — with no pane header and no app chrome, so the frames get the
 * whole tab. It stays a working canvas: each frame's options pill, version
 * stepper and actions, and the size & zoom chip — and, on hover, Exit back to
 * the prototype's canvas in the full app. Nothing is remembered here — a reload
 * reopens the canvas the link carries.
 */
export function PresentCanvasPage(): ReactElement {
  const { name, canvas } = prototypePresentCanvasPane.useParams();
  const opened = decodeCanvas(canvas);
  if (opened.kind === "rejected") {
    return (
      <Text as="div" variant="body" tone="muted" className="p-lg">
        This link does not hold a canvas ({opened.reason}).
      </Text>
    );
  }
  return (
    <PrototypeDetailProvider name={name} initialCanvas={opened.state}>
      <PresentBox>
        <CanvasStage
          exit={<LeaveToCanvasButton name={name} variant="floating" />}
        />
      </PresentBox>
    </PrototypeDetailProvider>
  );
}
