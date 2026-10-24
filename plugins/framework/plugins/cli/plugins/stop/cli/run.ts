import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  readPid,
  isRunning,
  awaitProcessGone,
  terminateProcess,
  GATEWAY_SERVICE,
} from "@plugins/infra/plugins/launcher/server";
import {
  declaredLoginServices,
  loginServiceId,
  loginServiceManager,
  type LoginService,
} from "@plugins/infra/plugins/launcher/plugins/login-services/machine";

const run: CliAction<[], { disable?: boolean }> = async (opts) => {
  const manager = loginServiceManager();

  // Every declared login service first — they run against the gateway, so they
  // go before it. None is named here.
  const declared = manager
    ? (await declaredLoginServices()).map((d) => ({
        decl: d,
        service: manager.service(loginServiceId(d)),
      }))
    : [];
  for (const { decl, service } of declared) {
    if (await unloadIfLoaded(service, `${decl.id} (${decl.owner})`))
      console.log(`${decl.id} stopped.`);
  }

  let stopped = false;
  const loginService = manager?.service(GATEWAY_SERVICE) ?? null;
  if (loginService && (await unloadIfLoaded(loginService, "the gateway")))
    stopped = true;

  // A gateway no service manager owns: a `start` without one, or one from
  // before the gateway was a service.
  const pid = readPid();
  if (pid !== null && isRunning(pid)) {
    console.log(`Stopping the gateway (PID ${pid})...`);
    await terminateProcess(pid);
    stopped = true;
  }

  console.log(stopped ? "Gateway stopped." : "Gateway is not running.");

  if (!loginService) return;
  const at = loginService.startsAt;
  if (opts.disable) {
    for (const { decl, service } of declared) {
      if (await service.remove())
        console.log(
          `Removed ${service.definitionPath()}: ${decl.id} no longer starts at ${service.startsAt}.`,
        );
    }
    console.log(
      (await loginService.remove())
        ? `Removed ${loginService.definitionPath()}: it no longer starts at ${at}. \`./equin start\` registers it again.`
        : `It was not registered to start at ${at}.`,
    );
  } else {
    console.log(
      `It starts again at the next ${at} (\`./equin stop --disable\` to prevent that), or now with \`./equin start\`.`,
    );
  }
};

/** Stop `service` through its manager if the manager holds it; whether it did. */
async function unloadIfLoaded(
  service: LoginService,
  what: string,
): Promise<boolean> {
  const state = await service.state();
  if (state.kind !== "loaded") return false;
  console.log(
    `Stopping ${what} through ${service.manager}${state.pid !== null ? ` (PID ${state.pid})` : ""}...`,
  );
  await service.unload();
  if (state.pid !== null) await awaitProcessGone(state.pid);
  return true;
}

export default run;
