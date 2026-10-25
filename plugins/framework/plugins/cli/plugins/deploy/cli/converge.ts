/**
 * `./equin deploy converge <composition> --server <server>` — make a host
 * serve a composition: run user, dir layout, the `env` EnvironmentFile, Caddy,
 * the systemd unit, the firewall.
 *
 * Every refusal comes BEFORE the first host mutation, and each is named: a
 * non-Debian host, a hostname a Caddyfile cannot hold, a composition carrying
 * owner data behind a public hostname, a closure needing `infra/secrets`, or a
 * deploy secret the closure declares that the user has not approved for this
 * deployment. Past those, the whole host state is one generated, idempotent
 * script, and the approved secrets reach it over the SSH session's stdin.
 */
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { listenAddress } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { isLinuxTag } from "@plugins/release/core";
import {
  assertCaddySafeHostname,
  assertClosureSafe,
} from "./internal/closure-guards";
import { convergeScript } from "./internal/converge-script";
import { approvedSecretEnv, secretEnvStdin } from "./internal/secret-env";
import {
  CONVERGE_MS,
  refuse,
  resolveTarget,
  runScript,
} from "./internal/target";

const run: CliAction<[string], { server: string }> = async (
  composition,
  opts,
) => {
  const target = await resolveTarget({
    composition,
    serverRef: opts.server,
  });
  const { install, deployment, server } = target;

  console.log(`Converging "${composition}" on ${server.name} (${server.host})`);
  console.log(`  Install: ${install.installDir} as ${install.runUser}`);
  console.log(`  Listen:  ${listenAddress(deployment.loopbackPort)}`);
  console.log(
    `  Hosts:   ${
      deployment.hostnames.length > 0
        ? deployment.hostnames.join(", ")
        : "(none — loopback only)"
    }`,
  );

  // ── Refusals, all of them before the first host mutation ──────────────────
  // apt-get / systemd / ufw make this script Debian-family-specific, so a
  // non-Linux server is a refusal rather than a confusing mid-script error.
  if (!isLinuxTag(target.platform)) {
    refuse(
      `server "${server.name}" reports ${target.platform}; converge targets Debian/Ubuntu ` +
        `Linux (it uses apt-get, systemd and ufw).`,
    );
  }
  for (const hostname of deployment.hostnames)
    assertCaddySafeHostname(hostname);
  await assertClosureSafe(target);
  // The last refusal: a deploy secret the closure needs and the user has not
  // approved (for exactly its current value) stops converge here, before the
  // host is touched. Keys are printed; values never are.
  const secrets = await approvedSecretEnv(deployment.id);
  console.log(
    `  Secrets: ${
      secrets.length > 0 ? secrets.map((s) => s.key).join(", ") : "(none)"
    }`,
  );

  await runScript(target, {
    script: convergeScript({
      install,
      hostnames: deployment.hostnames,
      loopbackPort: deployment.loopbackPort,
      sshPort: server.port,
      sshUser: server.sshUser,
      secretKeys: secrets.map((s) => s.key),
    }),
    remoteName: `equin-converge-${composition}.sh`,
    timeoutMs: CONVERGE_MS,
    what: "converge",
    // Values travel ONLY here: the SSH session's stdin.
    stdin: secretEnvStdin(secrets),
  });

  console.log(`\n[done] ${server.name} is converged for "${composition}".`);
  console.log(
    `  Ship a bundle: ./equin deploy ship ${composition} --server ${opts.server}`,
  );
};

export default run;
