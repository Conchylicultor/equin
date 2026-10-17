import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCopyToClipboard } from "./use-copy-to-clipboard";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const checkIcon = symbol("check");
const contentCopyIcon = symbol("content-copy");

export interface CopyButtonProps {
  text: string;
  /** The button's tooltip, and its accessible name. */
  tooltip?: string;
  className?: string;
  /** Button shape. "icon" = a square icon box at the ambient control density (the default); "inline" = collapses to surrounding text height. */
  aspect?: "icon" | "inline";
  /** Optional escape hatch to size/style the glyph. Unset → Button's per-size svg fallback (or icon-auto for "inline"). */
  iconClassName?: ClassName;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export function CopyButton({
  text,
  tooltip,
  className,
  aspect = "icon",
  iconClassName,
  onClick,
}: CopyButtonProps) {
  const { copy, copied } = useCopyToClipboard(text);
  return (
    <Button
      variant="ghost"
      aspect={aspect}
      className={className}
      tooltip={tooltip}
      aria-label={tooltip}
      onClick={(e) => {
        onClick?.(e);
        copy();
      }}
    >
      {copied ? (
        <Icon icon={checkIcon} className={iconClassName} />
      ) : (
        <Icon icon={contentCopyIcon} className={iconClassName} />
      )}
    </Button>
  );
}
