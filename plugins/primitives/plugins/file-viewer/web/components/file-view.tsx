import { FilepathBreadcrumb } from "@plugins/primitives/plugins/filepath-breadcrumb/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import type { FileLocation } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import type { FileViewerGit } from "../../core";
import { FileContent } from "./file-content";
import { FileTabs } from "./file-tabs";
import { useFileRenderers } from "./use-file-renderers";

/**
 * A self-contained file viewer: the path as a breadcrumb with the renderer tabs
 * beside it, over the active renderer's body in a scroll container. Hosts that
 * put the tabs in their own chrome compose `useFileRenderers` + `FileTabs` +
 * `FileContent` instead.
 */
export function FileView({
  file,
  git,
  line,
}: {
  file: FileLocation;
  git?: FileViewerGit;
  line?: number;
}) {
  const renderers = useFileRenderers({
    file,
    ...(git !== undefined ? { git } : {}),
  });
  return (
    <Column
      fill
      className="h-full"
      header={
        <Text as={Line} variant="body" className="gap-sm border-b px-sm py-xs">
          <Fill>
            <FilepathBreadcrumb path={file.path} />
          </Fill>
          <FileTabs {...renderers} />
        </Text>
      }
      body={
        <Scroll axis="both" className="h-full">
          <FileContent file={file} line={line} active={renderers.active} />
        </Scroll>
      }
      scrollBody={false}
    />
  );
}
