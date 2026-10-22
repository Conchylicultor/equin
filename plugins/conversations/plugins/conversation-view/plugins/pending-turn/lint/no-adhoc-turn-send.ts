import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * Endpoints that put user text in front of the running agent. Each is a
 * *delivery* — the transport half of a turn send — or the ledger's Retry of
 * one, which types it again.
 *
 * Matching is by imported binding name, not by module path: these names are
 * unique in the repo, and a consumer necessarily imports the binding to call
 * `fetchEndpoint` / `useEndpointMutation` with it.
 */
const TURN_ENDPOINTS = new Set([
  "postConversationTurn",
  "answerAskUserQuestion",
  "startPushAndExit",
  "retryConversationTurn",
]);

/** Only web code sends turns on a user's behalf; the server IMPLEMENTS these. */
function isWebFile(filename: string): boolean {
  return filename.includes("/web/") || filename.endsWith("/web/index.ts");
}

export default createRule({
  name: "no-adhoc-turn-send",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow calling a turn-delivery endpoint directly from web code — " +
        "every send must route through useSendConversationTurn so it gets a " +
        "ledger id, the optimistic echo and its card.",
    },
    schema: [],
    messages: {
      adhocTurnSend:
        "'{{name}}' delivers a turn to the agent, so calling it directly from " +
        "web code silently opts this surface out of the send lifecycle: no " +
        "client-minted ledger id (a repeated request types the turn twice), " +
        "no optimistic echo, and no card when it fails. Send through " +
        "useSendConversationTurn from " +
        "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web " +
        "instead — if your turn does not travel over POST /turn, build a " +
        "TurnDelivery and pass it as `delivery`.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!isWebFile(context.filename)) return {};
    return {
      ImportSpecifier(node) {
        const name =
          node.imported.type === "Identifier" ? node.imported.name : null;
        if (name && TURN_ENDPOINTS.has(name)) {
          context.report({
            node,
            messageId: "adhocTurnSend",
            data: { name },
          });
        }
      },
    };
  },
});
