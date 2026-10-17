import type { McpCatalogTool } from "@plugins/infra/plugins/mcp/core";

/** One top-level argument of a tool, read off its listed JSON Schema. */
export interface ToolParam {
  name: string;
  /** The type in words (`string`, `"a" | "b"`, `string[]`, …). */
  type: string;
  required: boolean;
  description: string | null;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A JSON Schema node's type, in words: enough to read an argument at a glance.
 * The full schema is one click away (the detail's raw JSON), so a shape this
 * does not spell reads as its bare `type` or `object`, never as a guess.
 */
export function schemaTypeWords(node: unknown): string {
  if (!isObject(node)) return "any";
  if (Array.isArray(node.enum)) {
    return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  if ("const" in node) return JSON.stringify(node.const);
  const union = node.anyOf ?? node.oneOf;
  if (Array.isArray(union)) {
    return union.map(schemaTypeWords).join(" | ");
  }
  if (node.type === "array") return `${schemaTypeWords(node.items)}[]`;
  if (Array.isArray(node.type)) return node.type.join(" | ");
  if (typeof node.type === "string") return node.type;
  return "any";
}

/** A tool's top-level arguments, in the schema's own order. */
export function toolParams(tool: McpCatalogTool): ToolParam[] {
  const { properties, required } = tool.inputSchema;
  if (!isObject(properties)) return [];
  const req = new Set(Array.isArray(required) ? required : []);
  return Object.entries(properties).map(([name, node]) => ({
    name,
    type: schemaTypeWords(node),
    required: req.has(name),
    description:
      isObject(node) && typeof node.description === "string"
        ? node.description
        : null,
  }));
}

export type ToolVisibility = "everywhere" | "gated" | "profile";

export const VISIBILITY_LABEL: Record<ToolVisibility, string> = {
  everywhere: "Every conversation",
  gated: "Gated per conversation",
  profile: "Scratch profiles only",
};

/** Who is listed the tool: a profile reservation wins over a gate, since a
 * reserved tool never reaches the default scope its gate would filter. */
export function toolVisibility(tool: McpCatalogTool): ToolVisibility {
  if (tool.profiles !== null) return "profile";
  return tool.gated ? "gated" : "everywhere";
}

/** The description's first line — what a row shows. */
export function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}
