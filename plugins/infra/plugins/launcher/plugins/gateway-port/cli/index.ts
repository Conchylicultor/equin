import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * `./equin url` — main's address on this account's port, for a script (install.sh)
 * or a person: the one place a shell learns the port without spelling it.
 */
export default defineCliCommand<[], object>({
  name: "url",
  description:
    "Print the address equin is served at on this account (http://equin.localhost:<port> — the port is chosen once from 8700–8709 by `./equin start`). Reads only.",
  run: () => import("./url"),
});
