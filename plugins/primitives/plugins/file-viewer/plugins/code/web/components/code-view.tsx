import {
  NoPreview,
  type FileRendererProps,
} from "@plugins/primitives/plugins/file-viewer/web";
import {
  fileTextUnavailableMessage,
  useFileText,
} from "@plugins/infra/plugins/paths/plugins/file-systems/web";
import {
  CodeListing,
  CodePaneSurface,
} from "@plugins/primitives/plugins/syntax-highlight/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";

export function CodeView({ file, line }: FileRendererProps) {
  const state = useFileText(file);

  // On the listing's own surface, so the pane is the code's colour from the
  // first frame rather than the app's until the file arrives.
  if (state.kind === "loading")
    return (
      <CodePaneSurface>
        <Loading />
      </CodePaneSurface>
    );
  if (state.kind === "unavailable") {
    // A file the read found binary is not an error: it gets the same
    // "No preview" body the fallback renderer shows for known binary formats.
    if (state.reason === "binary") return <NoPreview file={file} />;
    return (
      <Placeholder tone="error">
        {fileTextUnavailableMessage(state)}
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
    <CodeListing
      code={state.content}
      path={file.path}
      highlightLine={line}
      variant="pane"
    />
  );
}
