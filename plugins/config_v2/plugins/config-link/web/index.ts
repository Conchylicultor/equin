import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { ConflictWriteToast } from "./components/conflict-write-toast";

export { useConfigLink } from "./internal/use-config-link";
export {
  ConfigGearButton,
  type ConfigGearButtonProps,
} from "./components/config-gear-button";
export {
  ConfigPopoverHeader,
  type ConfigPopoverHeaderProps,
} from "./components/config-popover-header";
export {
  ConfigMenuHeader,
  type ConfigMenuHeaderProps,
} from "./components/config-menu-header";
export {
  ConfigSelectContent,
  type ConfigSelectContentProps,
} from "./components/config-select-content";
export {
  ConfigMenuContent,
  type ConfigMenuContentProps,
} from "./components/config-menu-content";

export default {
  description:
    "Deep-link affordances from any config-backed surface to its settings section. useConfigLink() links a descriptor to its config pane; ConfigGearButton and ConfigPopoverHeader surface it as a gear; ConfigSelectContent / ConfigMenuContent bake the gear into Select / DropdownMenu picker chrome. At Core.Root, ConflictWriteToast says why a config change was refused while its document is in conflict, with a Resolve link to the config.",
  contributions: [Core.Root({ component: ConflictWriteToast })],
} satisfies PluginDefinition;
