import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints:no-raw-json-handlers",
    paths: ["machine/internal/handle-mcp.ts"],
    kind: "sanctioned",
    reason:
      "The MCP route speaks JSON-RPC, not an implement() endpoint: a request it fails to serve is answered as a JSON-RPC error body with HTTP 500 (attached to the rethrown error via answerThrowWith), so the agent reads the failed tool and its cause.",
  },
] satisfies Exemptions;
