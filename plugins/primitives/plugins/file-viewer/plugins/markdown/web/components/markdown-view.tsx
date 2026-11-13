import { type FileRendererProps } from "@plugins/primitives/plugins/file-viewer/web";
import {
  fileTextUnavailableMessage,
  useFileText,
} from "@plugins/infra/plugins/paths/plugins/file-systems/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { PaneMessage } from "@plugins/primitives/plugins/pane/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { splitFrontmatter } from "../internal/frontmatter";
import { FrontmatterCard } from "./frontmatter-card";

/**
 * The document's reading inset: the density group's `documentPad*` tokens
 * (defaults = the `py-md` / `px-lg` it always had), so the host that wants the
 * page set with its own margins says so in its theme — a document sub-theme
 * around the viewer — rather than through a prop every file-viewer host would
 * have to thread to one renderer.
 */
const DOCUMENT_INSET = {
  padding:
    "var(--document-pad-top) var(--document-pad-x) var(--document-pad-bottom)",
};

export function MarkdownView({ file }: FileRendererProps) {
  const state = useFileText(file);

  if (state.kind === "loading") {
    return (
      <PaneMessage>
        <Loading />
      </PaneMessage>
    );
  }
  if (state.kind === "unavailable") {
    return (
      <PaneMessage>
        <Placeholder tone="error">
          {fileTextUnavailableMessage(state)}
        </Placeholder>
      </PaneMessage>
    );
  }
  if (state.kind === "error") {
    return (
      <PaneMessage>
        <Placeholder tone="error">
          {state.message || "Failed to load file."}
        </Placeholder>
      </PaneMessage>
    );
  }

  const split = splitFrontmatter(state.content);

  return (
    <Text as="div" variant="body" style={DOCUMENT_INSET}>
      {split && <FrontmatterCard fields={split.fields} />}
      {(split ? split.body : state.content).trim() && (
        <Markdown>{split ? split.body : state.content}</Markdown>
      )}
    </Text>
  );
}
