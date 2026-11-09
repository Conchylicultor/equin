import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { convPushProfilingPane } from "../panes";
import { symbol } from "@plugins/ui/plugins/icons/core";

const timelineIcon = symbol("timeline");

export function PushProfilingButton() {
  const { isOpen, toggle } = convPushProfilingPane.useToggle({});

  return (
    <IconButton
      icon={timelineIcon}
      label="Op profiling"
      variant={isOpen ? "secondary" : "ghost"}
      aria-pressed={isOpen}
      {...linkProps(toggle)}
    />
  );
}
