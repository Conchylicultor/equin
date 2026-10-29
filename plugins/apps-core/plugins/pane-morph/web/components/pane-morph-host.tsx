import { useEffect, type ReactNode } from "react";
import { paneMorphSink } from "@plugins/primitives/plugins/pane/web";
import { morphPane } from "../internal/morph";

/** Installs the pane → app morph into the pane primitive's sink for as long as the app is mounted. */
export function PaneMorphHost(): ReactNode {
  useEffect(() => paneMorphSink.install(morphPane), []);
  return null;
}
