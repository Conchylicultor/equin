import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { installApp } from "../../core";
import { installApp as install } from "./install";

/** `POST /api/menu-bar/install/:appId` (`installApp`, needsMachine). */
export const handleInstallApp = implementMachine(installApp, ({ params }) =>
  install(params.appId),
);
