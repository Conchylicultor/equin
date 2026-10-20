import type { ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  Pane,
  PaneChrome,
  resolveFrom,
  useOpenPane,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import {
  automationDetailRoute,
  automationsCatalog,
  automationsRoute,
} from "../core";
import { AutomationsView } from "./components/automations-view";
import { AutomationDetail } from "./components/automation-detail";

// Panes are declared first so their types are known before the component
// bodies reference them (the bodies are hoisted function declarations).

export const automationsPane = Pane.define({
  title: "Automations",
  route: automationsRoute,
  app: agentManagerApp,
  component: AutomationsBody,
  width: 420,
});

function useResolveAutomation({
  automationId,
}: {
  automationId: string;
}): ResolveResult {
  const catalog = useLive(automationsCatalog);
  // No catalog on this host: nothing can say whether the automation exists,
  // and the body shows why — never "not found".
  if (catalog.status === "unavailable") return { status: "found" };
  return resolveFrom(catalog, (list) =>
    list.some((a) => a.id === automationId),
  );
}

/** The automation's label, once the catalog is known. */
function useAutomationTitle({
  automationId,
}: {
  automationId: string;
}): string | undefined {
  // No title until the catalog is known; a failed read leaves the tab
  // untitled (the pane body renders that failure).
  return foldResource(useLive(automationsCatalog), {
    loading: () => undefined,
    error: () => undefined,
    // No catalog on this host: untitled, the body says why.
    unavailable: () => undefined,
    ready: (list) => list.find((a) => a.id === automationId)?.label,
  });
}

// Detail (/agents/automations/automation/<id>): one automation — what it does,
// its schedule and Run now, its behaviour, its sources and the tasks it filed.
export const automationDetailPane = Pane.define({
  route: automationDetailRoute,
  app: agentManagerApp,
  useResolve: useResolveAutomation,
  title: { useText: useAutomationTitle },
  component: AutomationDetailBody,
  width: 520,
});

function AutomationsBody(): ReactElement {
  const openPane = useOpenPane();
  const selectedId = automationDetailPane.useRouteEntry()?.params.automationId;
  return (
    <PaneChrome pane={automationsPane}>
      <div className="rail-lg">
        <AutomationsView
          selectedId={selectedId}
          linkTo={(automationId) =>
            openPane.to(
              automationDetailPane,
              { automationId },
              { mode: "push" },
            )
          }
        />
      </div>
    </PaneChrome>
  );
}

function AutomationDetailBody(): ReactElement {
  const { automationId } = automationDetailPane.useParams();
  return (
    <PaneChrome pane={automationDetailPane}>
      <AutomationDetail automationId={automationId} />
    </PaneChrome>
  );
}
