import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { ConvExplorerBody } from "./components/conv-explorer-body";

export const convFileTreePane = Pane.define({
  title: "Files",
  // The explorer's location rides the route like `/files/at/…` does — the
  // folder (`;dir`, absent = the checkout) and the file open beside it
  // (`;open`) — so every folder is a link, back / forward are the browser
  // history, and Open in Files lands where the user is.
  route: defineRoute({
    id: "conv-file-tree",
    segment: "files;dir;open",
  }),
  app: agentManagerApp,
  // Conversation-scoped satellite: promote() would strip convId from the URL.
  // Its way out is Open in Files (OpenInFilesAction), at the current location.
  chrome: { promote: false },
  component: ConvExplorerChromedBody,
  // Tree plus the selected file's preview beside it.
  width: 960,
});

function ConvExplorerChromedBody() {
  return (
    <PaneChrome pane={convFileTreePane}>
      <ConvExplorerBody />
    </PaneChrome>
  );
}
