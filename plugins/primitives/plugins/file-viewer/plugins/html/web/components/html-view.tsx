import {
  useFileText,
  fileTextUnavailableMessage,
  type FileRendererProps,
} from "@plugins/primitives/plugins/file-viewer/web";
import { fileRefName } from "@plugins/primitives/plugins/file-viewer/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { InlineFrame } from "@plugins/primitives/plugins/embed/plugins/frame/web";
import { isolateHtml } from "../internal/isolate";

/**
 * The page as a browser draws it: the file's markup in a sandboxed `srcdoc`
 * frame — scripts allowed, but in an opaque origin and under the preview CSP
 * (`isolateHtml`), so it can neither read nor reach the app.
 */
export function HtmlView({ file }: FileRendererProps) {
  const state = useFileText(file);

  if (state.kind === "loading") {
    return <Loading />;
  }
  if (state.kind === "unavailable") {
    return (
      <Placeholder tone="error">
        {fileTextUnavailableMessage(state.reason)}
      </Placeholder>
    );
  }
  if (state.kind === "error") {
    return (
      <Placeholder tone="error">
        {state.message || "Failed to load file."}
      </Placeholder>
    );
  }

  return (
    <InlineFrame
      title={fileRefName(file)}
      html={isolateHtml(state.content)}
      allow={["scripts", "popups", "forms", "modals"]}
      className="block h-full w-full border-0 bg-white"
    />
  );
}
