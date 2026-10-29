import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

/**
 * no-adhoc-block-id
 *
 * A `page_blocks` id is minted from two sides — the client mints one before the
 * round trip so an optimistic op can render the block on the keystroke, the
 * server mints one for a row no editor is open on — and for two months each side
 * minted its OWN format: `block-<epoch-ms>-<6 base36 chars>` on the server, a
 * bare `crypto.randomUUID()` on the client. Nothing broke, because nothing
 * parses an id; what it cost was legibility. A page's URL announced which
 * handler had happened to create it, and the live table holds three shapes.
 *
 * `core/block-id.ts` is now the one mint (`newBlockId()`), and this rule is what
 * keeps it one. Inside the page-editor plugin it flags the two ways a second
 * format has actually appeared:
 *
 *  - `crypto.randomUUID()` — the client's old mint, and the tempting one-liner
 *    for anyone adding a `newId` to a new op.
 *  - a template literal interpolating directly after `block-` — the server's old
 *    mint, and any hand-rolled variation on it. The prefix must be the WHOLE
 *    leading text: an id is `block-` plus a generated body, so `block-text-${…}`
 *    (a Lexical namespace) is a different string that merely shares a stem.
 *
 * SCOPE. A contributed rule is enabled repo-wide, but only this plugin owns
 * block identity: `crypto.randomUUID()` is the correct, unremarkable call
 * everywhere else (reminder ids, tab ids, correlation ids), so the rule checks
 * the filename and stays silent outside `plugins/page/plugins/editor/`. Test and
 * e2e files are already exempt (NON_APP_FILE_GLOBS), which is what lets a
 * fixture keep writing readable `block-1`/`block-${i}` ids. `block-id.ts` itself
 * is exempted by path in the lint barrel.
 *
 * What this rule does NOT do is validate the format of an id it did not mint.
 * Rows created before `newBlockId()` existed keep their bare-uuid ids forever,
 * and they are re-inserted verbatim by an undo of a delete — so an id is an
 * opaque key on every path except the mint. See `core/block-id.ts`.
 *
 * AST-only and self-contained: a contributed lint rule file is loaded by jiti,
 * which cannot resolve the `@plugins/*` tsconfig alias, so it may not import
 * across plugins.
 */

const createRule = lintRuleCreator(import.meta.url);

/**
 * The plugin that owns `page_blocks` identity. Path-separator-agnostic so the
 * check holds if a caller ever hands ESLint Windows-shaped filenames.
 */
const OWNING_PLUGIN = "plugins/page/plugins/editor/";

/**
 * The block-id prefix. A template literal whose leading text is EXACTLY this,
 * with an interpolation right after it, is a mint.
 */
const ID_PREFIX = "block-";

export default createRule({
  name: "no-adhoc-block-id",
  meta: {
    type: "problem",
    docs: {
      description:
        "no ad-hoc page_blocks id minting outside core/block-id.ts " +
        "(a second mint is a second id FORMAT, which is how the table ended up with three)",
    },
    schema: [],
    messages: {
      adhocUuid:
        "`crypto.randomUUID()` inside the page editor mints a block id in a " +
        "second format. Call `newBlockId()` from `core/block-id.ts` — the one " +
        "mint, shared by the client's optimistic ops and the server's handlers, " +
        "so a block's id does not advertise which of the two created it.",
      adhocTemplate:
        "A `{{prefix}}…` template literal hand-rolls a block id. Call " +
        "`newBlockId()` from `core/block-id.ts` instead: it is the one mint, and " +
        "its uuid body cannot collide the way a timestamp-plus-random-suffix can.",
    },
  },
  defaultOptions: [],
  create(context) {
    // Outside the plugin that owns block identity, both patterns are ordinary
    // code. Bail once, up front, rather than per node.
    if (!context.filename.replaceAll("\\", "/").includes(OWNING_PLUGIN))
      return {};

    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.object.type === "Identifier" &&
          callee.object.name === "crypto" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "randomUUID"
        ) {
          context.report({ node, messageId: "adhocUuid" });
        }
      },
      TemplateLiteral(node: TSESTree.TemplateLiteral) {
        // Only an id being BUILT is a mint, which pins both halves of the shape:
        // the literal opens with EXACTLY `block-` (an id is the prefix plus a
        // generated body — `block-text-${id}` is a Lexical namespace, not an
        // id), and something is interpolated right after it. A constant string
        // that merely mentions the prefix (a message, a `LIKE 'block-%'`) has no
        // interpolation at all and never trips.
        const first = node.quasis[0];
        if (!first || node.expressions.length === 0) return;
        if (first.value.cooked !== ID_PREFIX) return;
        context.report({
          node,
          messageId: "adhocTemplate",
          data: { prefix: ID_PREFIX },
        });
      },
    };
  },
});
