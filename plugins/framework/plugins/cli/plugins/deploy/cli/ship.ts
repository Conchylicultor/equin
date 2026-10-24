/**
 * `./equin deploy ship <composition> --server <server> [--release <run-id>]`
 * — put a bundle on a converged host and activate it behind a health gate.
 *
 * Bundle discovery is `@plugins/release/plugins/bundles`, which returns a
 * verdict rather than exiting so a UI can ask the same question; ship's own job
 * is to turn that refusal into an exit, and to refuse an un-converged host
 * BEFORE a 100MB upload rather than at `systemctl restart` after it.
 */
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  UNIT_TEMPLATE_PATH,
  listenAddress,
  releaseDir,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { sshRun, sshUpload } from "@plugins/infra/plugins/ssh/server";
import { bundleRefusalMessage } from "@plugins/release/plugins/bundles/core";
import { resolveBundle } from "@plugins/release/plugins/bundles/server";
import { activateScript } from "./internal/activate-script";
import {
  ACTIVATE_MS,
  SSH_SHORT_MS,
  UPLOAD_MS,
  refuse,
  remote,
  resolveTarget,
  runScript,
  sshTargetFor,
  deployNamespace,
} from "./internal/target";

const run: CliAction<[string], { server: string; release?: string }> = async (
  composition,
  opts,
) => {
  const target = await resolveTarget({
    composition,
    serverRef: opts.server,
  });
  const { install, deployment, server } = target;

  // The platform is taken from the server's health row, never a flag —
  // and `resolveBundle` asserts RELEASE.json agrees with it. It returns a
  // verdict rather than exiting, so the same call answers for a UI; the
  // exit is this command's own translation of a refusal.
  const resolution = resolveBundle({
    // This checkout's own namespace — the same one a `release` run from here
    // writes under, so the two halves of a hand-run release/ship pair agree.
    namespace: await deployNamespace(),
    composition,
    platform: target.platform,
    release: opts.release,
  });
  if (!resolution.ok) refuse(bundleRefusalMessage(resolution.refusal));
  const bundle = resolution;
  const dir = releaseDir(composition, bundle.runId);

  console.log(
    `Shipping "${composition}" ${bundle.runId} to ${server.name} (${server.host})`,
  );
  console.log(`  Bundle:  ${bundle.localPath} (${target.platform})`);
  console.log(`  Target:  ${dir}/${bundle.binaryName}`);

  // Pre-flight: is this host actually converged for this composition?
  // Without it, an un-converged host fails at `systemctl restart` — after
  // a 100MB upload and a flip — so the honest refusal is here, before
  // either. `command-failed` means the remote `test` RAN and said no;
  // anything else is an SSH-layer problem and must not be read as "not
  // converged".
  const converged = await sshRun(sshTargetFor(target, SSH_SHORT_MS), [
    "test",
    "-f",
    UNIT_TEMPLATE_PATH,
    "-a",
    "-f",
    install.envFile,
  ]);
  if (!converged.ok) {
    if (converged.kind === "command-failed") {
      refuse(
        `server "${server.name}" is not converged for "${composition}" ` +
          `(${UNIT_TEMPLATE_PATH} or ${install.envFile} is missing). Run:\n` +
          `  ./equin deploy converge ${composition} --server ${opts.server}`,
      );
    }
    refuse(
      `checking whether ${server.name} is converged failed (${converged.kind}): ` +
        `${converged.message}\n${converged.stderr}`,
    );
  }

  // `scp` does not create the remote parent dir, and making the upload
  // primitive silently do two things would hide that from every caller.
  await remote(target, ["mkdir", "-p", dir], {
    timeoutMs: SSH_SHORT_MS,
    what: `creating ${dir}`,
  });

  console.log("  • uploading bundle");
  const upload = await sshUpload(
    sshTargetFor(target, UPLOAD_MS),
    bundle.localPath,
    `${dir}/${bundle.binaryName}`,
  );
  if (!upload.ok) {
    refuse(
      `uploading the bundle to ${server.name} failed (${upload.kind}): ` +
        `${upload.message}\n${upload.stderr}`,
    );
  }

  console.log("  • activating (flip + restart + health gate)");
  await runScript(target, {
    script: activateScript({
      install,
      runId: bundle.runId,
      binaryName: bundle.binaryName,
      loopbackPort: deployment.loopbackPort,
    }),
    remoteName: `equin-activate-${composition}.sh`,
    timeoutMs: ACTIVATE_MS,
    what: "activate",
  });

  console.log(
    `\n[done] ${server.name} is serving "${composition}" ${bundle.runId}.`,
  );
  if (deployment.hostnames.length > 0) {
    for (const hostname of deployment.hostnames) {
      console.log(`  https://${hostname}`);
    }
  } else {
    console.log(
      `  No hostname on this deployment — reachable only at ${listenAddress(
        deployment.loopbackPort,
      )} on the host.`,
    );
  }
};

export default run;
