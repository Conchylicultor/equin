import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * `./equin codesign status|reset` — which identity this machine signs the
 * gateway with, and starting the local one over.
 */
export default defineCliCommand({
  name: "codesign",
  description:
    "The code-signing identity this machine signs the gateway with: status, reset",
  subcommands: [
    defineCliCommand<[], object>({
      name: "status",
      description:
        "Print the identity the gateway is signed with on this machine (configured or local), its SHA-1 and its expiry. Creates nothing.",
      run: () => import("./internal/status"),
    }),
    defineCliCommand<[], object>({
      name: "reset",
      description:
        "Delete this machine's local code-signing identity (state/codesign/local). The next gateway build (`./equin start`) creates a new one and re-signs; macOS then asks again for every permission the gateway had.",
      run: () => import("./internal/reset"),
    }),
  ],
});
