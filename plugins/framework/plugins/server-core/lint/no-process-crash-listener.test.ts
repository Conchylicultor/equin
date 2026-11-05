/**
 * Tests for `no-process-crash-listener`: adding a crash listener to `process`
 * is reported, in every adding form; other events, removal and other emitters
 * are not.
 */

import rule from "./no-process-crash-listener";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const FILE = "/repo/plugins/foo/server/internal/hooks.ts";
const listener = (event: string) => ({
  messageId: "listener" as const,
  data: { event },
});

ruleTester.run("no-process-crash-listener", rule, {
  valid: [
    { code: `process.on("SIGTERM", () => {});`, filename: FILE },
    { code: `process.on("exit", () => {});`, filename: FILE },
    { code: `process.off("uncaughtException", fn);`, filename: FILE },
    {
      code: `process.removeListener("unhandledRejection", fn);`,
      filename: FILE,
    },
    { code: `emitter.on("uncaughtException", fn);`, filename: FILE },
    { code: `process.on(eventName, fn);`, filename: FILE },
    { code: `process.listenerCount("uncaughtException");`, filename: FILE },
  ],
  invalid: [
    ...[
      "on",
      "once",
      "addListener",
      "prependListener",
      "prependOnceListener",
    ].map((method) => ({
      code: `process.${method}("uncaughtException", fn);`,
      filename: FILE,
      errors: [listener("uncaughtException")],
    })),
    {
      code: `process.on("unhandledRejection", (reason) => {});`,
      filename: FILE,
      errors: [listener("unhandledRejection")],
    },
    {
      code: `process.on("uncaughtExceptionMonitor", fn);`,
      filename: FILE,
      errors: [listener("uncaughtExceptionMonitor")],
    },
    {
      code: `globalThis.process.once("unhandledRejection", fn);`,
      filename: FILE,
      errors: [listener("unhandledRejection")],
    },
    {
      code: `process.setUncaughtExceptionCaptureCallback(fn);`,
      filename: FILE,
      errors: [{ messageId: "captureCallback" as const }],
    },
  ],
});
