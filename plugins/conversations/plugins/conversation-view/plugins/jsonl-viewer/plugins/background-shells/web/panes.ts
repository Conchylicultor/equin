import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { ShellOutputPaneBody } from "./components/shell-output-pane";

/**
 * One background shell's live output, beside the conversation that launched
 * it. Keyed by the shell id alone: the conversation comes from the route above
 * it, and the server resolves the file from that conversation's transcript.
 */
export const shellOutputPane = Pane.define({
  route: defineRoute({ id: "shell-output", segment: "shell/:shellId" }),
  app: agentManagerApp,
  component: ShellOutputPaneBody,
  title: "Shell",
  // Conversation-scoped satellite: promote() would strip convId from the URL.
  chrome: { history: false, promote: false },
  useResolve: false,
});
