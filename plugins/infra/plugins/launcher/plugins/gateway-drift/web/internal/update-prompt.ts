import { GATEWAY_REFRESH_COMMAND } from "../../core";

/**
 * The first turn of the agent the Gateway row's Update launches: what differs,
 * and the one command that applies it. The user asked for it by clicking, which
 * is the explicit request `./equin start` needs.
 */
export function buildGatewayUpdatePrompt(
  differences: readonly string[],
  extra: string,
): string {
  const parts = [
    "The machine's gateway is out of date: the health report's Gateway row found that the installed / running gateway differs from what `" +
      GATEWAY_REFRESH_COMMAND +
      "` would install now from main:",
    "",
    ...differences.map((d) => `- ${d}`),
    "",
    `Apply it: run \`${GATEWAY_REFRESH_COMMAND}\` (I am explicitly asking for it). It always installs main's gateway, whichever checkout runs it, and it restarts the gateway and every backend — expected. Then confirm the gateway answers and the Gateway row reads up to date. If \`start\` fails, report the error and its cause instead of working around it.`,
  ];
  const context = extra.trim();
  if (context) parts.push("", "## Context", "", context);
  return parts.join("\n");
}
