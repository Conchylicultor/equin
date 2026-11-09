import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { FileViewer as FileViewerSlots } from "./slots";

export { FileViewer, resolveRenderers } from "./slots";
export type {
  FileRendererContribution,
  FileRendererProps,
  FileRendererTarget,
  RendererMatch,
  ResolvedRenderer,
} from "./slots";
export { FileView } from "./components/file-view";
export { UnloadedFile } from "./components/unloaded-file";
export { FileContent } from "./components/file-content";
export { FileTabs } from "./components/file-tabs";
export {
  NoPreview,
  type PreviewFailure,
  useArchiveMembership,
  useOpenHostFile,
} from "./components/no-preview";
export {
  useFileRenderers,
  type FileRenderersHandle,
} from "./components/use-file-renderers";
export default {
  description:
    "Domain-neutral file viewer: the tiered FileViewer.Renderer registry (native / contextual / fallback / last-resort, offered as tabs), the FileView / FileContent / FileTabs hosts, over a FileLocation in any file system (infra/paths/file-systems' reads: the computer's disk, the browser's storage, a checkout) — a renderer never asks which.",
  contributions: [],
  slots: { ...FileViewerSlots },
} satisfies PluginDefinition;
