/**
 * Tests for the `no-adhoc-structural-write` lint rule. Run with `bun test`.
 *
 * The valid/invalid lists are the real shapes from the page editor's web tree:
 * every non-structural endpoint call must pass, every call naming
 * `applyBlockOpEndpoint` / `patchBlocks` must fail (the two sanctioned homes are
 * exempted by PATH in the lint barrel, which this rule cannot and should not
 * know about).
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-adhoc-structural-write";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

// `RuleTester.run` drives the harness itself (it calls the ambient describe/it
// that bun:test provides), so it must run at module top level.
ruleTester.run(
  "no-adhoc-structural-write",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // The sanctioned route: dispatch through the store, which owns the lane.
      { code: `store.dispatch({ tag: "op", op, effect });` },
      {
        code: `dispatchOp({ kind: "move", blockId, parentId, targetId, zone });`,
      },
      // A write with no surface to predict it still goes on the lane — and a
      // lane enqueue is not itself a licence: wrapping is orthogonal to WHICH
      // endpoint is named, which is why the invalid list carries the same shape
      // around `patchBlocks`.
      {
        code:
          `void enqueueResourceWrite(pageBlocks, { where: { pageId } }, () =>` +
          ` fetchEndpoint(moveBlock, { id }, { body }));`,
      },
      // `moveBlock` is a live endpoint for the sidebar and the cross-page drop.
      { code: `await fetchEndpoint(moveBlock, { id }, { body });` },
      // Every other endpoint in this plugin is unaffected.
      { code: `await fetchEndpoint(listBlocks, { pageId });` },
      { code: `const { mutate } = useEndpointMutation(turnIntoPage);` },
      // Reading the endpoint definition is not calling it.
      { code: `const route = patchBlocks.route;` },
    ],
    invalid: [
      {
        code: `await fetchEndpoint(applyBlockOpEndpoint, { pageId }, { body: op });`,
        errors: [{ messageId: "adhocWrite" }],
      },
      {
        code: `void fetchEndpoint(patchBlocks, { pageId }, { body: patch });`,
        errors: [{ messageId: "adhocWrite" }],
      },
      {
        code: `const { mutate } = useEndpointMutation(applyBlockOpEndpoint);`,
        errors: [{ messageId: "adhocWrite" }],
      },
      {
        code: `const { mutate } = useEndpointMutation(patchBlocks);`,
        errors: [{ messageId: "adhocWrite" }],
      },
      // Wrapping the call in a lane enqueue does NOT license it OUTSIDE the two
      // exempt files: the lane is theirs to own, and a third writer holding it
      // is a third writer of page structure.
      {
        code:
          `void enqueueResourceWrite(pageBlocks, { where: { pageId } }, () =>` +
          ` fetchEndpoint(patchBlocks, { pageId }, { body: patch }));`,
        errors: [{ messageId: "adhocWrite" }],
      },
      // Every offender in a file is reported.
      {
        code:
          `await fetchEndpoint(applyBlockOpEndpoint, p, { body: op });` +
          `await fetchEndpoint(listBlocks, p);` +
          `await fetchEndpoint(patchBlocks, p, { body: patch });`,
        errors: [{ messageId: "adhocWrite" }, { messageId: "adhocWrite" }],
      },
    ],
  },
);
