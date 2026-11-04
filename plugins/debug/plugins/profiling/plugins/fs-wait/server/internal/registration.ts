import {
  getBootMode,
  type Registration,
} from "@plugins/framework/plugins/server-core/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { recordFsWaits } from "./record-fs-waits";

// A backend (serve) and an exec child record their file waits from their
// register phase on. A browser host has no disk: its graph never boots this
// (the server barrel needs the computer).
export const fsWaitRegistration: Registration = {
  register() {
    const mode = getBootMode();
    if (mode === "browser") return;
    recordFsWaits({
      process: mode === "serve" ? "backend" : "exec",
      namespace: runtimeNamespace(),
    });
  },
};
