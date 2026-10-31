import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActiveData, codeTag } from "@plugins/active-data/web";
import { FolderLinkChip } from "./components/folder-link-chip";
import { useFolderClaim } from "./internal/use-folder-claim";
import { FOLDER_PATH_RE } from "./internal/pattern";

export default {
  description:
    "Renders folder paths in backtick-wrapped inline code (`~/Downloads/showcase/`, `/tmp/out`, a path relative to the host's checkout) as clickable chips that browse the folder in a Files side pane. Stats the path on the host and declines unless it is a folder.",
  contributions: [
    ActiveData.Tag(
      codeTag({
        id: "folder-link",
        pattern: FOLDER_PATH_RE,
        useClaim: useFolderClaim,
        component: FolderLinkChip,
      }),
    ),
  ],
} satisfies PluginDefinition;
