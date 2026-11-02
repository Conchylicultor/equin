import type { InitialConfigType } from "@lexical/react/LexicalComposer";
import type { NodeExtension } from "./node-extensions";

export const TEXT_EDITOR_THEME = {
  text: { base: "" },
} as const;

export function buildInitialConfig(opts: {
  namespace: string;
  onError: (err: Error) => void;
  extensions: readonly NodeExtension[];
}): InitialConfigType {
  return {
    namespace: opts.namespace,
    theme: TEXT_EDITOR_THEME,
    nodes: opts.extensions.map((ext) => ext.node.Node),
    onError: opts.onError,
  };
}
