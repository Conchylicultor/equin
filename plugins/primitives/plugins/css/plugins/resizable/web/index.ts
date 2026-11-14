import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./components/resizable";

export default {
  description:
    "Resizable panel groups in the ui-kit look (react-resizable-panels): ResizablePanelGroup, ResizablePanel and ResizableHandle.",
  contributions: [],
} satisfies PluginDefinition;
