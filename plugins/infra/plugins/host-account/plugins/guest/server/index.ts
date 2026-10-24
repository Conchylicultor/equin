import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { HostAccountSource } from "@plugins/infra/plugins/host-account/server";

export default {
  description:
    "The account of a host without the computer: provides the HostAccountSource host service as a fixed guest account (login `demo`, full name Alex Morgan), so a surface that greets the user — the Pages brand — renders as it does on the desktop (the browser composition, the portable boot test). Never booted by the desktop.",
  portable: true,
  contributions: [
    HostAccountSource.provide({
      read: () =>
        Promise.resolve({ username: "demo", fullName: "Alex Morgan" }),
    }),
  ],
} satisfies ServerPluginDefinition;
