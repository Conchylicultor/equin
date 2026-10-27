import type { ReactNode } from "react";
import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import { AppDataRoots } from "./components/app-data-roots";
import { AppDataBrowser } from "./components/app-data-browser";

/**
 * `/files/data` — App data: every file root an app declares browsable
 * (`data-files.roots`), the place's own landing.
 */
export const filesDataPane = Pane.define({
  route: defineRoute({ id: "files-data", segment: "data" }),
  app: fileExplorerApp,
  title: "App data",
  component: FilesData,
});

/**
 * `/files/data/<root>[/<path>]` — one root's folder, or one of its files
 * previewed beside its folder's listing. `at` is ONE encoded segment, a path
 * relative to the root (`proto-x%2Findex.html`); absent is the root itself.
 * Whether it names a folder or a file is the root's to say (`data-files.stat`).
 */
export const filesDataAtPane = Pane.define({
  route: defineRoute({ id: "files-data-at", segment: "data/:root/:at?" }),
  app: fileExplorerApp,
  title: { useText: useDataTitle },
  useResolve: false,
  component: FilesDataAt,
});

function useDataTitle(params: { root: string; at?: string }): string {
  const at = params.at;
  if (at === undefined) return params.root;
  return at.slice(at.lastIndexOf("/") + 1);
}

function FilesData(): ReactNode {
  return <AppDataRoots />;
}

function FilesDataAt(): ReactNode {
  const { root, at } = filesDataAtPane.useParams();
  return <AppDataBrowser root={root} at={at ?? ""} />;
}
