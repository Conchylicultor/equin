import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  resolveFrom,
  useOpenPane,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { backgroundEntryKey } from "@plugins/infra/plugins/background/plugins/catalog/core";
import {
  BackgroundView,
  EntryDetail,
  useBackgroundEntry,
} from "@plugins/infra/plugins/background/plugins/catalog/web";

const backgroundRoute = defineRoute({
  id: "debug-background",
  segment: "background",
});

export const backgroundPane = Pane.define({
  title: "Background activity",
  route: backgroundRoute,
  app: debugApp,
  component: BackgroundBody,
  width: 640,
});

function BackgroundBody(): ReactElement {
  const openPane = useOpenPane();
  const open = backgroundEntryPane.useRouteEntry()?.params;
  return (
    <PaneChrome pane={backgroundPane}>
      <BackgroundView
        selectedKey={open === undefined ? undefined : backgroundEntryKey(open)}
        linkTo={(e) =>
          openPane.to(
            backgroundEntryPane,
            { kind: e.kind, name: e.name },
            { mode: "push" },
          )
        }
      />
    </PaneChrome>
  );
}

function useResolveEntry({
  kind,
  name,
}: {
  kind: string;
  name: string;
}): ResolveResult {
  return resolveFrom(useBackgroundEntry(kind, name), (entry) => entry !== null);
}

// Detail (/debug/background/activity/<kind>/<name>): one entry — its trigger,
// scope, where it is declared, its recent runs and Run now.
export const backgroundEntryPane = Pane.define({
  title: "Background entry",
  route: defineRoute({
    id: "debug-background-entry",
    segment: "activity/:kind/:name",
    parent: backgroundRoute,
  }),
  app: debugApp,
  useResolve: useResolveEntry,
  component: BackgroundEntryBody,
  width: 460,
});

function BackgroundEntryBody(): ReactElement {
  const { kind, name } = backgroundEntryPane.useParams();
  return (
    <PaneChrome pane={backgroundEntryPane}>
      <EntryDetail kind={kind} name={name} />
    </PaneChrome>
  );
}
