import { useCopyToClipboard } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import {
  TitleActionButton,
  usePrototypeDetail,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const checkIcon = symbol("check");
const contentCopyIcon = symbol("content-copy");

/**
 * "Copy prototype ID" header action contributed to `prototypeDetailPane.Actions`.
 *
 * The id is the prototype's minted folder name (`proto-…`) — the one the
 * `./singularity prototype` commands and an agent prompt address it by. The
 * button stays put after a click, so its own check-mark flash (and the tooltip
 * reading "Copied") is the feedback; no toast.
 */
export function CopyIdAction() {
  const { name } = usePrototypeDetail();
  const { copy, copied } = useCopyToClipboard(name);
  return (
    <TitleActionButton
      icon={copied ? checkIcon : contentCopyIcon}
      label="Copy prototype ID"
      tooltip={copied ? "Copied" : "Copy prototype ID"}
      onClick={copy}
    />
  );
}
