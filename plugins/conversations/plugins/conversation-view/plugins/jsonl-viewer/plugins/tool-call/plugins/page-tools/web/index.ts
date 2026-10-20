import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { PageRefChip } from "./components/page-ref-chip";
export { PageWriteReport } from "./components/page-write-report";
export { PageMarkdown } from "./components/page-markdown";
export { PageToolError } from "./components/page-tool-error";

export default {
  collapsed: true,
  description:
    "Shared appearance for the Singularity page MCP tool rows (read_page / write_agent_note / edit_page): the page-identity chip, the apply-report chips, the markdown body, and the refusal block. Contributes no renderer itself — one sub-plugin per tool does.",
  contributions: [],
} satisfies PluginDefinition;
