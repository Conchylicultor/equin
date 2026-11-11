import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import type { FileLocation } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { FileViewer } from "../slots";
import { FileExpandContext } from "./file-expand";
import type { FileRenderersHandle } from "./use-file-renderers";
import { ReadGate } from "./unreadable-file";

/**
 * The active renderer's body for one file (no header, no scroll container),
 * off the host's renderers handle — which also takes the Expand the renderer
 * declares (`FileExpandAction`).
 */
export function FileContent({
  file,
  line,
  renderers,
}: {
  file: FileLocation;
  line?: number;
  renderers: FileRenderersHandle;
}) {
  const { active } = renderers;
  if (!active) {
    return <Placeholder>No renderer available for this file.</Placeholder>;
  }
  // Bespoke tiered selection (resolveRenderers) can't be expressed via
  // .Render/.Dispatch — render the chosen contribution through renderIsolated so
  // it still routes through the error-boundary middleware chain.
  const body = (
    <ContentScope>
      <FileExpandContext.Provider value={renderers.setExpand}>
      {renderIsolated(
        FileViewer.Renderer,
        active.contribution as unknown as Contribution,
        {
          file,
          line,
          ...(active.target.git !== undefined
            ? { git: active.target.git }
            : {}),
        },
      )}
      </FileExpandContext.Provider>
    </ContentScope>
  );
  // A file that is not there, or that the account cannot read, says why,
  // whichever renderer is on.
  return <ReadGate file={file}>{body}</ReadGate>;
}
