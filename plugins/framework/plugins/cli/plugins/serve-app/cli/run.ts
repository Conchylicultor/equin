import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { resolve } from "path";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  dataRoot,
  REPO_ROOT,
  SERVER_CORE_RELATIVE,
} from "@plugins/infra/plugins/paths/server";
import {
  bootSelfContainedApp,
  gatewayPidFile,
  LOOPBACK_BIND,
} from "@plugins/infra/plugins/launcher/server";
import { gatewayLogs } from "@plugins/infra/plugins/launcher/data-dirs";
import { gatewayBinary } from "@plugins/infra/plugins/launcher/deps";
import { ensureDep } from "@plugins/infra/plugins/deps/deps";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import {
  asNamespace,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";

const run: CliAction<
  [],
  {
    name: string;
    port: string;
    repoRoot?: string;
    server?: string;
    composition?: string;
    web: string;
    logLevel: string;
  }
> = async (opts) => {
  // The launcher is a release entry point: EQUIN_DIR must already
  // be set in the environment, because it re-roots the whole install. The
  // check is on the ENV rather than on `dataRoot()` precisely because
  // `dataRoot()` cannot express "explicitly set" — unset, it answers with
  // the dev ~/.singularity, and silently defaulting to that would pollute
  // the developer's data root with a release cluster, spec, and registry.
  if (!readEnv("DIR")) {
    console.error(
      `serve-app requires ${envName("DIR")} to be set in its environment.\n` +
        "Invoke the launcher with an isolated root, e.g.:\n" +
        "\n" +
        `  ${envName("DIR")}=$(mktemp -d /tmp/sonata-release.XXXX) \\\n` +
        "    bun plugins/framework/plugins/cli/bin/index.ts serve-app \\\n" +
        "      --name sonata --port 9100 --web <bundle>/web\n",
    );
    process.exit(1);
  }

  const port = Number(opts.port);
  if (!Number.isInteger(port) || port <= 0) {
    console.error(`Invalid --port: ${opts.port}`);
    process.exit(1);
  }

  // `--name` is operator input: validate before it becomes a subdomain, a
  // spec dir and a database name.
  const name = asNamespace(opts.name);

  // The `--repo-root` default, resolved HERE rather than by commander: it is
  // `REPO_ROOT`, which lives behind a server barrel, and this command's
  // declaration — reached on every `./equin` invocation — may import no
  // server barrel. The option's help text states the default so it stays
  // discoverable from `serve-app --help`.
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const server = opts.server ?? resolve(repoRoot, SERVER_CORE_RELATIVE);

  await bootSelfContainedApp({
    name,
    // Built from `repoRoot`'s gateway source into the deps cache — or read
    // from `deps.sealed.json` when `--repo-root` names a release bundle.
    gateway: await ensureDep(gatewayBinary, cliExecContext(), {
      root: repoRoot,
      log: console.log,
    }),
    server,
    web: opts.web,
    composition: opts.composition ?? opts.name,
    port,
    // Loopback only (127.0.0.1 and [::1]), like every launch that names no
    // wildcard: the URL printed below is `localhost`.
    bindHost: LOOPBACK_BIND,
    repoRoot,
    logLevel: opts.logLevel,
    log: console.log,
  });

  // One of `dataRoot()`'s two sanctioned uses: naming the root itself,
  // here to report it and to reach a pidfile under it. Never to join a
  // path under it — that is what `defineDataDir` is for.
  const root = dataRoot();
  const pidFile = gatewayPidFile(root);
  console.log("");
  console.log(`App "${opts.name}" is serving.`);
  // A packaged app listens on its own port, not the dev gateway's.
  console.log(`  URL:  ${namespaceUrl(name, "", port)}`);
  console.log(`  Root: ${root}`);
  console.log(`  PID:  ${pidFile}`);
  console.log(`  Logs: ${gatewayLogs.path}/`);
};

export default run;
