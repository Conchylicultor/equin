import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { pinApp } from "../../core";
import { pinApp as pin } from "./shims";

/** `POST /api/menu-bar/pin/:appId` (`pinApp`, needsMachine). */
export const handlePinApp = implementMachine(pinApp, ({ params }) =>
  pin(params.appId),
);
