import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import type { FileRef } from "../../core";
import { FileViewer, type ResolvedRenderer } from "../slots";
import { HostReadGate } from "./unreadable-host-file";

/** The active renderer's body for one file (no header, no scroll container). */
export function FileContent({
  file,
  line,
  active,
}: {
  file: FileRef;
  line?: number;
  active: ResolvedRenderer | null;
}) {
  if (!active) {
    return <Placeholder>No renderer available for this file.</Placeholder>;
  }
  // Bespoke tiered selection (resolveRenderers) can't be expressed via
  // .Render/.Dispatch — render the chosen contribution through renderIsolated so
  // it still routes through the error-boundary middleware chain.
  const body = (
    <ContentScope>
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
    </ContentScope>
  );
  // A host file the account cannot read says why, whichever renderer is on.
  return file.source === "host" ? (
    <HostReadGate path={file.path}>{body}</HostReadGate>
  ) : (
    body
  );
}
