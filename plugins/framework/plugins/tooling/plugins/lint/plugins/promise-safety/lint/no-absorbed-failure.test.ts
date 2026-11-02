/**
 * Tests for the `no-absorbed-failure` lint rule. Run with `bun test`.
 *
 * The rule bans a `catch` (try/catch clause or `.catch(handler)`) that resolves
 * to an absorbable empty-default (`[]`, `{}`, `null`, `undefined`/`void 0`,
 * `""`, `0`, `false`, or a const initialized to one) — republishing failure as
 * ordinary data. Escape hatches: a reachable `throw` (specific-handling), a
 * discriminated result object (`{ kind }`/`{ ok }`/…), or a per-site disable.
 * Bare `return;` and returns inside nested functions are never flagged.
 */

import rule from "./no-absorbed-failure";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-absorbed-failure", rule, {
  valid: [
    // Specific-handling: narrow, return default for the expected case, rethrow.
    {
      code: `try { f(); } catch (e) { if (e instanceof X) return null; throw e; }`,
    },
    // Discriminated results are a TYPE the caller branches on, not an absorbed empty.
    {
      code: `try { f(); } catch (e) { return { kind: "error", message: String(e) }; }`,
    },
    { code: `try { f(); } catch (e) { return { ok: false }; }` },
    { code: `try { f(); } catch (e) { return { status: "failed" }; }` },
    // .catch that rethrows (wrapped) — the failure still propagates.
    { code: `p.catch((e) => { throw new Wrapped(e); });` },
    { code: `p.catch((e) => ({ kind: "error", cause: e }));` },
    // No return at all — that is no-bare-catch's territory, not ours.
    { code: `try { f(); } catch (e) { log(e); }` },
    // Bare `return;` in a void function is normal control flow.
    {
      code: `function run() { try { f(); } catch (e) { report(e); return; } }`,
    },
    // A non-empty value carried out of the catch is a real result, not an absorb.
    { code: `try { f(); } catch (e) { return fallbackValue; }` },
    { code: `try { f(); } catch (e) { return { rows: parsed, count: n }; }` },
    // A nested function's `return []` belongs to IT, not the catch's control flow.
    {
      code: `try { f(); } catch (e) { items.forEach(() => { return []; }); report(e); }`,
    },
    // .catch(() => {}) is an empty BLOCK — handled by no-bare-catch, not here.
    { code: `p.catch(() => {});` },
    // Raw-body read tolerance (escape #3): reading bytes/text and degrading to
    // an empty value on read failure is the optional-read idiom, not a collapse.
    { code: `const t = await res.text().catch(() => "");` },
    { code: `const b = await res.arrayBuffer().catch(() => null);` },
    { code: `const src = await Bun.file(p).text().catch(() => null);` },
  ],
  invalid: [
    // try/catch returning each empty-default flavor.
    {
      code: `try { f(); } catch (e) { return []; }`,
      errors: [{ messageId: "absorbedCatch" }],
    },
    {
      code: `try { f(); } catch (e) { return null; }`,
      errors: [{ messageId: "absorbedCatch" }],
    },
    {
      code: `try { f(); } catch (e) { return 0; }`,
      errors: [{ messageId: "absorbedCatch" }],
    },
    {
      code: `try { f(); } catch (e) { return {}; }`,
      errors: [{ messageId: "absorbedCatch" }],
    },
    {
      code: `try { f(); } catch (e) { return ""; }`,
      errors: [{ messageId: "absorbedCatch" }],
    },
    {
      code: `try { f(); } catch (e) { return false; }`,
      errors: [{ messageId: "absorbedCatch" }],
    },
    {
      code: `try { f(); } catch (e) { return undefined; }`,
      errors: [{ messageId: "absorbedCatch" }],
    },
    {
      code: `try { f(); } catch (e) { return void 0; }`,
      errors: [{ messageId: "absorbedCatch" }],
    },
    // A local const initialized to an empty-default is resolved one level.
    {
      code: `try { f(); } catch (e) { const d = []; return d; }`,
      errors: [{ messageId: "absorbedCatch" }],
    },
    // .catch handler forms.
    {
      code: `p.catch(() => null);`,
      errors: [{ messageId: "absorbedCatchHandler" }],
    },
    {
      code: `p.catch(() => []);`,
      errors: [{ messageId: "absorbedCatchHandler" }],
    },
    // Parenthesized object literal — the empty `{}` is the resolved value.
    {
      code: `p.catch(() => ({}));`,
      errors: [{ messageId: "absorbedCatchHandler" }],
    },
    {
      code: `p.catch(function () { return ""; });`,
      errors: [{ messageId: "absorbedCatchHandler" }],
    },
    {
      code: `p.catch((e) => { log(e); return []; });`,
      errors: [{ messageId: "absorbedCatchHandler" }],
    },
    // `.json()` is NOT raw-body-exempt — it decodes structured data a consumer
    // branches on, so absorbing it to an empty array is a real collapse.
    {
      code: `const rows = await res.json().catch(() => []);`,
      errors: [{ messageId: "absorbedCatchHandler" }],
    },
  ],
});
