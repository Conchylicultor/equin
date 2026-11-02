/**
 * Tests for the `no-adhoc-turn-send` lint rule. Run with `bun test`.
 *
 * The rule bans importing a turn-delivery endpoint into web code, which is how
 * a surface silently opts out of the pending-turn send lifecycle. It fires on
 * the import specifier (the binding a `fetchEndpoint` call would need), only in
 * files under a `web/` segment — server files legitimately implement these
 * routes, and the three sanctioned delivery modules are declared in
 * the pending-turn plugins' `exempt/index.ts`.
 */

import rule from "./no-adhoc-turn-send";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const WEB =
  "/repo/plugins/conversations/plugins/conversation-view/plugins/x/web/components/x.tsx";
const SERVER =
  "/repo/plugins/conversations/server/internal/handle-post-turn.ts";

ruleTester.run("no-adhoc-turn-send", rule, {
  valid: [
    // The sanctioned entry point — what every surface should import.
    {
      filename: WEB,
      code: `import { useSendConversationTurn } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";`,
    },
    // Unrelated conversation endpoints are not turn deliveries.
    {
      filename: WEB,
      code: `import { stopConversation, exitConversation } from "@plugins/conversations/core";`,
    },
    // Server code implements these routes — the rule is web-only.
    {
      filename: SERVER,
      code: `import { postConversationTurn } from "../../core/endpoints";`,
    },
    // A local identifier that merely shares the name is not an import.
    {
      filename: WEB,
      code: `const postConversationTurn = 1; export default postConversationTurn;`,
    },
  ],
  invalid: [
    {
      filename: WEB,
      code: `import { postConversationTurn } from "@plugins/conversations/core";`,
      errors: [{ messageId: "adhocTurnSend" }],
    },
    {
      filename: WEB,
      code: `import { answerAskUserQuestion } from "../../shared";`,
      errors: [{ messageId: "adhocTurnSend" }],
    },
    {
      filename: WEB,
      code: `import { startPushAndExit } from "../../shared";`,
      errors: [{ messageId: "adhocTurnSend" }],
    },
    // The ledger's Retry types the turn again.
    {
      filename: WEB,
      code: `import { retryConversationTurn } from "@plugins/conversations/core";`,
      errors: [{ messageId: "adhocTurnSend" }],
    },
    // Mixed import: only the offending specifier is reported.
    {
      filename: WEB,
      code: `import { stopConversation, postConversationTurn } from "@plugins/conversations/core";`,
      errors: [{ messageId: "adhocTurnSend" }],
    },
  ],
});
