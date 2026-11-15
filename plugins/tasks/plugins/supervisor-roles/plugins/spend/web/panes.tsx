import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  useOpenPane,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { supervisorsSpendRoute } from "../core";
import { SpendDetail } from "./components/spend-detail";
import { pathParam } from "./internal/format";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";

// The breakdown (/agents/supervisors/spend/<path>), in the list's detail
// column like a role: one level at a time, the path in the URL.
export const supervisorsSpendPane = Pane.define({
  // The body's own title is the drill path; the header keeps only its
  // controls (expand, close), so the pane does not say "Spend" twice. Tab and
  // document titles still read "Spend".
  title: { useText: "Spend", component: NoHeaderTitle },
  route: supervisorsSpendRoute,
  app: agentManagerApp,
  // Every path opens: a level that left the tree (its spend fell out of the
  // window) shows the deepest one still in it.
  useResolve: false,
  component: SpendBody,
});

function NoHeaderTitle(): null {
  return null;
}

function SpendBody(): ReactElement {
  const { path } = supervisorsSpendPane.useParams();
  const openPane = useOpenPane();
  const setParams = supervisorsSpendPane.useSetParams();
  // Another level of the same breakdown: this instance's path rewritten in
  // place (a history entry, so Back returns to it) — the same React instance,
  // so the move between the two levels animates. ⌘/middle-click opens the
  // level's URL in a browser tab.
  const linkTo = (next: readonly string[]): LinkTarget => ({
    open: () => setParams({ path: pathParam(next) }),
    href: () =>
      openPane
        .to(supervisorsSpendPane, { path: pathParam(next) }, { mode: "swap" })
        .href(),
  });
  return (
    <PaneChrome pane={supervisorsSpendPane}>
      <SpendDetail path={path} linkTo={linkTo} />
    </PaneChrome>
  );
}
