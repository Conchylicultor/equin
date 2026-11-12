import { Pane } from "@plugins/primitives/plugins/pane/web";
import {
  prototypeDetailRoute,
  prototypesApp,
} from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import { PrototypeDetail, PrototypeTitle } from "./components/prototype-detail";
import { usePrototypeTitle } from "./internal/use-prototype-title";

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
