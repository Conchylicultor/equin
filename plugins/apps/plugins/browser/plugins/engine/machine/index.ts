import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ENGINE_WS_PATH } from "../core";
import {
  engineHostDaemon,
  engineStatusWatcher,
  stopStatusWatcher,
} from "./internal/host-client";
import { engineRelay } from "./internal/relay";

export default {
  description:
    "The Browser app's engine, backend half: relays each viewed tab's socket (ENGINE_WS_PATH) byte for byte to the machine's engine host over its Unix socket — launching the host (a detached `bin/host.ts`, Chromium on a persistent profile in apps/browser/profile) when there is none, after checking Chromium is installed (requesting the install when not), and replacing it when it runs other code and this backend is main or the namespace that launched it.",
  register: [engineHostDaemon, engineStatusWatcher],
  wsRoutes: {
    [ENGINE_WS_PATH]: engineRelay,
  },
  onShutdown: stopStatusWatcher,
} satisfies MachinePluginDefinition;
