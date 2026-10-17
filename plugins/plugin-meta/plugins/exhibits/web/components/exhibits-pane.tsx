import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  useOpenPane,
} from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useExhibit } from "../use-exhibits";
import { ExhibitsList } from "./exhibits-list";
import { ExhibitDetail } from "./exhibit-detail";

const exhibitsRoute = defineRoute({
  id: "exhibits",
  segment: "exhibits",
});

export const exhibitsPane = Pane.define({
  title: "Exhibits",
  route: exhibitsRoute,
  app: debugApp,
  component: ExhibitsBody,
  width: 520,
});

// `:id*` because an exhibit id is `<group>/<name>`: the URL spells it as path
// (`/debug/exhibits/x/task-draft/composer`), so an agent or a link can name one
// exhibit directly. `;theme` is the theme its frames wear (an app id, or
// `chrome`); absent = the exhibit's declared `home`, else Debug's (this pane's own).
export const exhibitPane = Pane.define({
  route: defineRoute({
    id: "exhibit",
    segment: "x/:id*;theme",
    parent: exhibitsRoute,
  }),
  app: debugApp,
  title: { useText: ({ id }) => id },
  component: ExhibitBody,
  useResolve: false,
  width: 1040,
});

function ExhibitsBody(): ReactElement {
  const openPane = useOpenPane();
  const selected = exhibitPane.useRouteEntry()?.params.id;
  return (
    <PaneChrome pane={exhibitsPane}>
      <ExhibitsList
        selectedId={selected}
        linkTo={(id) => openPane.to(exhibitPane, { id }, { mode: "push" })}
      />
    </PaneChrome>
  );
}

function ExhibitBody(): ReactElement {
  const { id, theme } = exhibitPane.useParams();
  const setParams = exhibitPane.useSetParams();
  const found = useExhibit(id);
  return (
    <PaneChrome pane={exhibitPane}>
      {found.kind === "loading" ? (
        <Inset pad="lg">
          <Loading label="Loading exhibit…" />
        </Inset>
      ) : found.kind === "found" ? (
        <ExhibitDetail
          exhibit={found.exhibit}
          theme={theme}
          onTheme={(t) => setParams({ id, theme: t })}
        />
      ) : (
        <Inset pad="lg">
          <Text variant="body" tone="muted">
            {found.kind === "missing"
              ? `No exhibit is called “${id}” in this build.`
              : `Several plugins contribute an exhibit called “${id}”.`}
          </Text>
        </Inset>
      )}
    </PaneChrome>
  );
}
