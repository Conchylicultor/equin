/**
 * Tests for the `no-sentinel-param` lint rule: a `""` stand-in for a live
 * read's param that has not arrived yet.
 */

import rule from "./no-sentinel-param";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const sentinel = { messageId: "sentinel" as const };

ruleTester.run("no-sentinel-param", rule, {
  valid: [
    { code: `useLive(v, id === null ? null : { id });` },
    { code: `useLive(v, { id });` },
    { code: `useLive(v, { path, scopeId });` },
    { code: `useLive(c, { where: { status: "open" } });` },
    { code: `useLive(v);` },
    { code: `useLiveRow(c, id);` },
    { code: `useLiveRow(c, id ?? null);` },
    // Not a live read.
    { code: `useThing(v, { id: x ?? "" });` },
    // A computed value is not traced.
    { code: `const id = x ?? ""; useLive(v, { id });` },
  ],
  invalid: [
    { code: `useLive(v, { id: x ?? "" });`, errors: [sentinel] },
    { code: `useLive(v, { id: x || "" });`, errors: [sentinel] },
    { code: `useLive(v, { id: "" });`, errors: [sentinel] },
    { code: "useLive(v, { id: `` });", errors: [sentinel] },
    { code: `useLive(v, { id: a ? a.id : "" });`, errors: [sentinel] },
    {
      code: `useLive(v, identity ? { conversationId: identity.id } : { conversationId: "" });`,
      errors: [sentinel],
    },
    {
      code: `useLive(v, { path: p ?? "", scopeId: s ?? "" });`,
      errors: [sentinel, sentinel],
    },
    { code: `useLiveRow(c, id ?? "");`, errors: [sentinel] },
  ],
});
