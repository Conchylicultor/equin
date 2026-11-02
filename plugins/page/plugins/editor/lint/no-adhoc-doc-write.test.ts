/**
 * Tests for the `no-adhoc-doc-write` lint rule. Run with `bun test`.
 *
 * The valid/invalid lists are the real shapes from the page editor's web tree:
 * a splice onto a throwaway headless doc must pass, every `applyUpdate` onto an
 * owner-shaped doc must fail (the four sanctioned homes — the replay host, the
 * two transport providers and the binding relay — are exempted by PATH in the
 * lint barrel, which this rule cannot and should not know about).
 */

import rule from "./no-adhoc-doc-write";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-adhoc-doc-write", rule, {
  valid: [
    // A headless replica minted in place: what the replay hosts and the
    // stored-state reader splice, never an owner's canonical.
    { code: `const doc = new Doc(); applyUpdate(doc, state);` },
    { code: `const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);` },
    // A seed doc read off a call — `runsToXmlText(runs).doc` — is a throwaway too.
    {
      code: `const doc = runsToXmlText(runs).doc; Y.applyUpdate(doc, delta, origin);`,
    },
    { code: `Y.applyUpdate(runsToXmlText(runs).doc, delta);` },
    // A parameter is not an owner read this rule can see; the caller is judged.
    {
      code: `function applyAs(doc: Y.Doc, origin: unknown) { Y.applyUpdate(doc, delta, origin); }`,
    },
    // A `doc` minted in THIS function is judged by its own declaration, not
    // by a same-named owner read in another function of the file.
    {
      code:
        `function read(owner) { const doc = owner.doc; return encode(doc); }` +
        `function runsOfState(state) { const doc = new Doc(); applyUpdate(doc, state); }`,
    },
    // The sanctioned route: a data entry replayed through the host selector.
    {
      code: `await applyBlockRuns({ blockId, runs, expected, direction: "undo" });`,
    },
    { code: `spliceOpenBlockDoc(owner, runs);` },
    // Reading an owner's doc is fine — only WRITING onto it is the hazard.
    { code: `const state = encodeStateAsUpdate(owner.doc);` },
    { code: `const runs = projectableRunsOf(owner.doc);` },
  ],
  invalid: [
    {
      code: `applyUpdate(owner.doc, delta, MY_ORIGIN);`,
      errors: [{ messageId: "adhocWrite" }],
    },
    {
      code: `Y.applyUpdate(session.owner.doc, bytes);`,
      errors: [{ messageId: "adhocWrite" }],
    },
    {
      code: `applyUpdate(this.doc, this.seedState, this);`,
      errors: [{ messageId: "adhocWrite" }],
    },
    {
      code: `Y.applyUpdate(blockDocOwnerOf(id)?.doc, delta);`,
      errors: [{ messageId: "adhocWrite" }],
    },
    {
      code: `applyUpdate(owner.doc as Doc, delta);`,
      errors: [{ messageId: "adhocWrite" }],
    },
    // A local bound to an owner's doc is the same write, one line later.
    {
      code: `const doc = owner.doc; Y.applyUpdate(doc, delta, origin);`,
      errors: [{ messageId: "adhocWrite" }],
    },
    // Every offender in a file is reported, and the throwaway between them is not.
    {
      code:
        `applyUpdate(owner.doc, a);` +
        `const scratch = new Doc(); applyUpdate(scratch, b);` +
        `applyUpdate(other.doc, c);`,
      errors: [{ messageId: "adhocWrite" }, { messageId: "adhocWrite" }],
    },
  ],
});
