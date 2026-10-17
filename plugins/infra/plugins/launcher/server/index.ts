import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { attachGateway, gatewayDaemon } from "./internal/gateway-daemon";

export {
  assertSupportedHost,
  readPid,
  isRunning,
  isGatewayListening,
  awaitGatewayReady,
  hasPgBouncerPackage,
  pgbouncerService,
  pgbouncerConnection,
  ensureDatabaseConfig,
  writeReleaseDatabaseConfig,
  bundledGateway,
  spawnGatewayDaemon,
  gatewayLaunchSpec,
  awaitProcessGone,
  terminateProcess,
  awaitPgReady,
  bootSelfContainedApp,
  seedReleaseAssetMirror,
  propagateReleaseConfig,
  teardownSelfContainedApp,
  gatewayPidFile,
} from "./internal/boot";
export type { GatewayLaunchOptions } from "./internal/boot";
export { gatewayLoginService } from "./internal/login-service";
export { GATEWAY_SERVICE_LABEL } from "./internal/gateway-service";
export type {
  GatewayLoginService,
  GatewayServiceState,
} from "./internal/gateway-service";
export {
  LISTEN_ENV,
  resolveListenAddress,
  listenFlag,
} from "./internal/listen";
export type { ListenAddress } from "./internal/listen";

export default {
  description:
    "Boots and tears down the self-contained stack (Go gateway, embedded Postgres, PgBouncer) for ./singularity start, serve-app and the release launcher, and keeps the gateway's launch spec in one place. In a running backend it attaches the gateway it runs behind as a long-lived process in Background activity.",
  register: [gatewayDaemon],
  onReady: () => {
    attachGateway();
  },
} satisfies ServerPluginDefinition;
