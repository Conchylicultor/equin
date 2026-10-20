import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { attemptWorkServed } from "./internal/resource";

export default {
  description:
    "The attempt-work live value, desktop-only half: where an attempt stands relative to `main`, measured from git in the attempt's checkout, so a host without the computer answers it unavailable.",
  contributions: [...attemptWorkServed.declare],
} satisfies MachinePluginDefinition;
