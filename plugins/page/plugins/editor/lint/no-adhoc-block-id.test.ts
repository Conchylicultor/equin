/**
 * Tests for the `no-adhoc-block-id` lint rule. Run with `bun test`.
 *
 * Two axes matter here, and the cases below cover both: WHAT the rule flags (a
 * `crypto.randomUUID()` call, a `block-…` template being built) and WHERE it is
 * allowed to fire (only inside the page-editor plugin — everywhere else those
 * are ordinary code the rule must not touch).
 */

import rule from "./no-adhoc-block-id";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

/** A file inside the plugin that owns block identity — the rule is live here. */
const INSIDE = "plugins/page/plugins/editor/web/block-editor-context.tsx";
/** A page plugin that does NOT own block identity. */
const SIBLING = "plugins/page/plugins/inline-date/web/inline-date-plugin.tsx";

ruleTester.run("no-adhoc-block-id", rule, {
  valid: [
    // The sanctioned mint, at both kinds of call site.
    { filename: INSIDE, code: `const newId = newBlockId();` },
    { filename: INSIDE, code: `const id = newBlockId();` },
    // Outside the owning plugin both patterns are unremarkable: a reminder id,
    // a tab id, a correlation id. The rule must stay silent.
    { filename: SIBLING, code: `const reminderId = crypto.randomUUID();` },
    {
      filename: "plugins/primitives/plugins/scope/plugins/tab-id/web/tab-id.ts",
      code: `const tabId = crypto.randomUUID();`,
    },
    // …including a `block-`-prefixed template that is not a block id at all.
    {
      filename: "plugins/debug/plugins/logs/web/log-row.tsx",
      code: `const testId = \`block-\${id}\`;`,
    },
    // A CONSTANT string mentioning the prefix is not a mint — no interpolation,
    // so nothing is being built. This is what keeps queries and messages clean.
    { filename: INSIDE, code: `const like = "block-%";` },
    { filename: INSIDE, code: "const msg = `block-id must be minted`;" },
    // The prefix has to be the WHOLE leading text: `block-text-` is a Lexical
    // namespace built from an id, not an id. This is the real shape in
    // `web/components/block-text-editor.tsx` that the first cut of the rule
    // wrongly flagged.
    {
      filename: INSIDE,
      code: `const cfg = { namespace: \`block-text-\${block.id}\` };`,
    },
    // …and it has to OPEN the literal: an id inside a URL or a sentence is
    // being read, not minted.
    { filename: INSIDE, code: `const url = \`/pages/page/\${pageId}\`;` },
    { filename: INSIDE, code: `const err = \`no block-\${kind} handler\`;` },
  ],
  invalid: [
    // The client's old mint — the `newId` one-liner on a new op.
    {
      filename: INSIDE,
      code: `const newId = crypto.randomUUID();`,
      errors: [{ messageId: "adhocUuid" }],
    },
    // The server's old mint, verbatim.
    {
      filename:
        "plugins/page/plugins/editor/server/internal/handle-create-block.ts",
      code: `const id = \`block-\${Date.now()}-\${Math.random().toString(36).slice(2, 8)}\`;`,
      errors: [{ messageId: "adhocTemplate" }],
    },
    // Any variation on it, including one built from the sanctioned uuid.
    {
      filename: INSIDE,
      code: `const id = \`block-\${crypto.randomUUID()}\`;`,
      errors: [{ messageId: "adhocTemplate" }, { messageId: "adhocUuid" }],
    },
    // The forest mint, had it stayed in `serialized-block.ts` (only
    // `core/block-id.ts` is exempt, and that exemption lives in the barrel).
    {
      filename: "plugins/page/plugins/editor/core/serialized-block.ts",
      code: `const node = { ...n, id: crypto.randomUUID() };`,
      errors: [{ messageId: "adhocUuid" }],
    },
  ],
});
