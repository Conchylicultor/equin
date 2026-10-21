import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { prototypeDetailPane } from "./panes";
import {
  FrameSource,
  PrototypeDetailWrap,
  PrototypeFrameActions,
  PrototypeVersionActions,
} from "./slots";
import {
  CloseFrameAction,
  KeepOnlyFrameAction,
} from "./components/frame-actions";
import {
  CompareVersionAction,
  OpenVersionConversation,
} from "./components/version-list";
import {
  frameChipsTheme,
  optionRowsTheme,
  versionRowsTheme,
} from "./internal/sub-themes";

export { prototypeDetailPane } from "./panes";
export {
  FrameSource,
  PrototypeDetailWrap,
  PrototypeFrameActions,
  PrototypeVersionActions,
} from "./slots";
export type {
  FrameActionRow,
  FrameResolution,
  FrameLaunch,
  FrameSourceMeta,
  FrameSourceProps,
} from "./slots";
export {
  PrototypeDetailProvider,
  documentOptions,
  openCanvasInApp,
  prototypeDocumentSrc,
  useFramePicks,
  useFrameSrc,
  usePrototypeDetail,
} from "./context";
export type { CanvasSourceEntry, PrototypeDetailContextValue } from "./context";
export { canvasWith, frameA, prototypeFrames } from "./internal/canvas-model";
export type {
  CanvasAction,
  CanvasAddAction,
  CanvasFrame,
  CanvasLayout,
  CanvasSize,
  CanvasState,
  CanvasZoom,
  FrameId,
  PrototypeFrame,
  SourceFrame,
} from "./internal/canvas-model";
export { layoutFrames, roomPerFrame } from "./internal/layout";
export { useWindowSize } from "./internal/use-window-size";
export type { FrameLayout, Room } from "./internal/layout";
export { pageHeightOf, sameExtent } from "./internal/page-extent";
export type { PageExtent } from "./internal/page-extent";
export { letterOf } from "./internal/frame-name";
export { CanvasFrameView } from "./components/canvas-frame-view";
export type { CanvasFrameViewProps } from "./components/canvas-frame-view";
export { OptionsPill } from "./components/options-pill";
export { VersionStepper } from "./components/version-stepper";
export type { VersionStepperProps } from "./components/version-stepper";
export { SizeChip } from "./components/size-chip";
export { AddFrameRail } from "./components/add-frame-rail";
export type { AddFrameHandlers } from "./components/add-frame-rail";
export { useFrameNames } from "./components/canvas";
export { TitleActionButton } from "./components/title-action";

export default {
  description:
    "The prototype detail pane as a canvas of frames: the prototype (frame A reads and writes the shared option picks, every other frame holds its own), each with its own options chip and version stepper in its header, beside frames from contributed sources (FrameSource — the real app, from compare); one canvas-wide size & zoom chip (Responsive / device presets / custom, Fit or 10–200%, Whole page), a Width slider that resizes every frame and snaps to the presets, side-by-side or swipe, keep-only with Undo, link and spread across frames; the whole canvas is remembered per pane for the browser tab's session, so a reload reopens it as it was left while a new pane starts fresh.",
  contributions: [
    Pane.Register({ pane: prototypeDetailPane }),
    ThemeEngine.SubTheme(frameChipsTheme),
    ThemeEngine.SubTheme(optionRowsTheme),
    ThemeEngine.SubTheme(versionRowsTheme),
    PrototypeFrameActions({ id: "keep-only", component: KeepOnlyFrameAction }),
    PrototypeFrameActions({ id: "close", component: CloseFrameAction }),
    PrototypeVersionActions({
      id: "compare",
      component: CompareVersionAction,
    }),
    PrototypeVersionActions({
      id: "open-conversation",
      component: OpenVersionConversation,
    }),
  ],
  slots: {
    "prototypes-detail": prototypeDetailPane,
    "frame-actions": PrototypeFrameActions,
    "frame-source": FrameSource,
    "detail-wrap": PrototypeDetailWrap,
    "version-actions": PrototypeVersionActions,
  },
} satisfies PluginDefinition;
