import { defineInlineTokenNode } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/core";
import { PickedBox } from "../components/picked-box";

/**
 * A picked checklist line's `- [x] ` prefix, drawn as a checked box in a draft — the
 * line ✎ Go put there reads as a ticked item, as it does once sent, while the
 * draft's text (what is sent) keeps the markdown. Line-start only.
 */
export type GoPickFields = { mark: "x" };

const goPickNode = defineInlineTokenNode<GoPickFields>({
  type: "go-pick",
  fields: ["mark"],
  token: () => "- [x] ",
  fieldsOf: () => ({ mark: "x" }),
  textContent: "token",
});

export const goPickWebNode = goPickNode.decorated({
  render: () => <PickedBox />,
});
