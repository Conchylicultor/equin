import { Pane } from "@plugins/primitives/plugins/pane/web";
import {
  prototypeDetailRoute,
  prototypesApp,
} from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { prototypesList } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { PrototypeDetail, PrototypeTitle } from "./components/prototype-detail";

/**
 * The pane's tab/document title: the prototype's own `<title>`, or undefined
 * while the list loads or there is no such folder (the fallback is the id).
 */
function usePrototypeTitle({ name }: { name: string }): string | undefined {
  const result = useLive(prototypesList);
  switch (result.status) {
    case "loading":
    case "error":
      return undefined;
    case "ready":
      break;
  }
  return result.data.find((p) => p.name === name)?.title;
}

/**
 * One prototype's canvas, at `proto/<id>` (what the CLI prints). It reopens as
 * this browser last left it — see `PrototypeDetailProvider`'s `remember`.
 */
export const prototypeDetailPane = Pane.define({
  route: prototypeDetailRoute,
  app: prototypesApp,
  useResolve: false,
  component: PrototypeDetail,
  title: {
    useText: usePrototypeTitle,
    fallback: (params) => params.name,
    component: PrototypeTitle,
  },
});
