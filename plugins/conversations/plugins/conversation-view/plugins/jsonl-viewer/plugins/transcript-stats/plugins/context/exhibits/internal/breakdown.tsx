import type { ContextUsage } from "@plugins/conversations/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Breakdown } from "../../web/components/context-card";

// The two readings the card was redesigned against: a 200k window close to
// auto-compact, and a 1M window barely used — where the bar zooms in.
function usage(window: number, messages: number): ContextUsage {
  const setup = [
    { name: "System prompt", tokens: 2_500, kind: "used" as const },
    { name: "System tools", tokens: 11_000, kind: "used" as const },
    { name: "MCP tools", tokens: 1_300, kind: "used" as const },
    { name: "Memory files", tokens: 28_000, kind: "used" as const },
    { name: "Skills", tokens: 5_800, kind: "used" as const },
  ];
  const total = setup.reduce((s, c) => s + c.tokens, messages);
  const reserve = 33_000;
  return {
    model: "exhibit",
    totalTokens: total,
    rawMaxTokens: window,
    autoCompactThreshold: window - reserve,
    isAutoCompactEnabled: true,
    categories: [
      ...setup,
      { name: "Messages", tokens: messages, kind: "used" },
      { name: "Free space", tokens: window - total - reserve, kind: "free" },
      { name: "Autocompact buffer", tokens: reserve, kind: "buffer" },
    ],
    memoryFiles: [
      { path: "/repo/CLAUDE.md", tokens: 14_000 },
      { path: "/repo/docs/plugins-compact.md", tokens: 14_000 },
    ],
    mcpTools: [{ name: "query_db", serverName: "equin", tokens: 1_300 }],
    messageBreakdown: {
      toolCallTokens: 0.14 * messages,
      toolResultTokens: 0.58 * messages,
      attachmentTokens: 0.03 * messages,
      assistantMessageTokens: 0.2 * messages,
      userMessageTokens: 0.05 * messages,
    },
  };
}

export default function BreakdownExhibit() {
  return (
    <Stack gap="xl">
      <Breakdown usage={usage(200_000, 107_000)} />
      <Breakdown usage={usage(1_000_000, 10_000)} />
    </Stack>
  );
}
