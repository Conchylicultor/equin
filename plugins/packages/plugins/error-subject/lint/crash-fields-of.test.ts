import rule from "./crash-fields-of";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const SERVER = "/repo/plugins/foo/server/internal/report.ts";

ruleTester.run("crash-fields-of", rule, {
  valid: [
    {
      code: `report({ message: e.message, ...crashFieldsOf(e, "job") });`,
      filename: SERVER,
    },
    // Derived, then the type overridden by a declared identity.
    {
      code: `report({ message, ...crashFieldsOf(err), errorType: "DbConnectionError" });`,
      filename: SERVER,
    },
    // A relay carrying the scope it was recorded with.
    {
      code: `record({ errorType: r.errorType, stack: r.stack, scope: r.scope ?? null });`,
      filename: SERVER,
    },
    // Crash fields relayed whole.
    { code: `report({ message, ...event.crash });`, filename: SERVER },
    {
      code: `const x = { errorType: "JobDeadline", stack: null };`,
      filename: SERVER,
    },
    // A stack synthesized for a declared type: no error, no subject.
    {
      code: `report({ data: { errorType: "MissingCompanion", stack: new Error(m).stack ?? null } });`,
      filename: SERVER,
    },
    // A stack with no type, handed to something other than a crash channel.
    { code: `log({ message: m, stack: err.stack });`, filename: SERVER },
  ],
  invalid: [
    {
      code: `reportServerError({ message: m, stack: err instanceof Error ? err.stack : null });`,
      filename: SERVER,
      errors: [{ messageId: "handCopied" }],
    },
    // A declared type does not excuse a stack copied off the error: its
    // subject is still dropped.
    {
      code: `report({ errorType: "DbConnectionError", stack: err.stack ?? null });`,
      filename: SERVER,
      errors: [{ messageId: "handCopied" }],
    },
    {
      code: `report({ errorType: event.errorType, stack: event.stack });`,
      filename: SERVER,
      errors: [{ messageId: "relayedWithoutScope" }],
    },
    {
      code: `report({ errorType: err.name, stack: err.stack ?? null });`,
      filename: SERVER,
      errors: [{ messageId: "handCopied" }],
    },
    {
      code: `const d = { stack: e instanceof Error ? e.stack : null, errorType: e instanceof Error ? e.name : typeof e };`,
      filename: SERVER,
      errors: [{ messageId: "handCopied" }],
    },
    {
      code: `const stack = error.stack ?? null; const d = { errorType: error.name, stack };`,
      filename: SERVER,
      errors: [{ messageId: "handCopied" }],
    },
    {
      code: `const d = { errorType: err?.name ?? null, stack: err?.stack ?? null };`,
      filename: SERVER,
      errors: [{ messageId: "handCopied" }],
    },
  ],
});
