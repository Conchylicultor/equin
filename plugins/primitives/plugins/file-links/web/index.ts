import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { FILE_PATH_RE, URL_RE, parseFileLinks } from "./internal/parse";
export type { FileLinkSegment } from "./internal/parse";
export { FileLinkText } from "./internal/file-link-text";
export type { FileLinkTextProps } from "./internal/file-link-text";
export { linkifyChildren } from "./internal/linkify-children";
export {
  FileLinksWorkspaceProvider,
  useFileLinksWorkspace,
} from "./internal/workspace-context";
export type { FileLinksWorkspace } from "./internal/workspace-context";

export default {
  description:
    "Parses inline file paths (e.g. `research/foo.md`) in plain text and renders them as clickable chips activating fileTarget(path, line) (a LinkTarget, so ⌘/middle-click opens a browser tab). Exposes <FileLinkText/>, parseFileLinks(), and linkifyChildren() for use inside ReactMarkdown component overrides, and <FileLinksWorkspaceProvider/> / useFileLinksWorkspace(): the checkout a subtree's paths name, supplied by whoever hosts the content (outside every provider, paths stay plain).",
  contributions: [],
} satisfies PluginDefinition;
