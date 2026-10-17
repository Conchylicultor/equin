import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  readPid,
  isRunning,
  awaitProcessGone,
  terminateProcess,
  gatewayLoginService,
} from "@plugins/infra/plugins/launcher/server";

const run: CliAction<[], { disable?: boolean }> = async (opts) => {
  let stopped = false;
  const loginService = gatewayLoginService();

  if (loginService) {
    const service = await loginService.state();
    if (service.kind === "loaded") {
      console.log(
        `Stopping the gateway ${loginService.manager} service${service.pid !== null ? ` (PID ${service.pid})` : ""}...`,
      );
      await loginService.unload();
      if (service.pid !== null) await awaitProcessGone(service.pid);
      stopped = true;
    }
  }

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
    console.log(
      (await loginService.remove())
        ? `Removed ${loginService.definitionPath()}: it no longer starts at ${at}. \`./singularity start\` registers it again.`
        : `It was not registered to start at ${at}.`,
    );
  } else {
    console.log(
      `It starts again at the next ${at} (\`./singularity stop --disable\` to prevent that), or now with \`./singularity start\`.`,
    );
  }
};

export default run;
