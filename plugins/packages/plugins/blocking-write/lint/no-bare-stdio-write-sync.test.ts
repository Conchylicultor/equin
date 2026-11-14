import rule from "./no-bare-stdio-write-sync";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const CLI = "/repo/plugins/foo/cli/internal/out.ts";

ruleTester.run("no-bare-stdio-write-sync", rule, {
  valid: [
    { code: `writeAllSync(1, "x");`, filename: CLI },
    { code: `writeSync(fd.fd, "x"); writeSync(3, "x");`, filename: CLI },
    { code: `fs.writeSync(owned.fd, buf);`, filename: CLI },
    { code: `await Bun.write(Bun.stdout, "x");`, filename: CLI },
  ],
  invalid: [
    {
      code: `writeSync(1, "x");`,
      filename: CLI,
      errors: [{ messageId: "bare" }],
    },
    {
      code: `fs.writeSync(2, buf, 0, n);`,
      filename: CLI,
      errors: [{ messageId: "bare" }],
    },
    {
      code: `writeSync(process.stdout.fd, "x"); writeSync(process.stderr.fd, "y");`,
      filename: CLI,
      errors: [{ messageId: "bare" }, { messageId: "bare" }],
    },
  ],
});
