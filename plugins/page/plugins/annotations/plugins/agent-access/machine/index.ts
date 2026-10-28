import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  editPageTool,
  pageInstructionsSection,
  readPageTool,
  writeAgentNoteTool,
} from "./internal/mcp-tools";

export default {
  description:
    "The page tools as MCP tools, desktop-only half: read_page, write_agent_note and edit_page (names, descriptions — edit_page's with the live tag vocabulary — and input schemas, each handler a call into the server half's pageTools), and the page-instructions section of the MCP server instructions. Here because MCP serves the agents launched on the computer.",
  register: [
    readPageTool,
    writeAgentNoteTool,
    editPageTool,
    pageInstructionsSection,
  ],
} satisfies MachinePluginDefinition;
