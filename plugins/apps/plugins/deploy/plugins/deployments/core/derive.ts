/**
 * **The declared owner of remote-host filesystem facts.**
 *
 * Two kinds of thing live here, and only here:
 *
 * 1. Everything about a deployed install that is DERIVED from the composition
 *    name (below) — because the alternative is a column per value, and a column
 *    is something a human can set wrong.
 * 2. Absolute paths and interpreter locations **on the deployed host**.
 *
 * (2) is a genuinely distinct category from the paths `@plugins/infra/plugins/paths`
 * owns, and conflating them is a real error rather than a stylistic one: that
 * plugin resolves paths on *this* machine, whereas every path here describes a
 * *different* machine — an Ubuntu box, reached over SSH, whose layout has nothing
 * to do with the developer's laptop. A dev-host constant used in a generated
 * remote script would be silently wrong (this machine is macOS; the target is
 * not), so `paths` deliberately does not and cannot supply them.
 *
 * That is why `paths:no-hardcoded-paths` allowlists THIS file specifically, on
 * exactly the same principle by which it allowlists `paths.ts` itself and
 * `database/plugins/embedded/shared/internal/paths.ts`: the owner of a path
 * family is source-of-truth territory, while every consumer stays policed. So a
 * new remote-host path belongs **here**, named, not inlined into the CLI's
 * generated scripts — where the check would (correctly) reject it.
 *
 * `runUser` is the reason this file exists rather than a wider `deploy_deployments`
 * row. Its only real requirement is *not root* (embedded Postgres refuses to
 * `initdb` as uid 0), and a configurable field with a default is a field someone
 * can set back to `root`. Deriving `svc-<composition>` makes "never root"
 * inexpressible rather than merely discouraged.
 *
 * The composition name is the ONLY identity below the URL — the install dir, the
 * systemd instance, the runtime namespace, and the database all carry it (see
 * `research/2026-07-29-global-composition-production-deployment.md`, §One name,
 * end to end). Every name here is therefore a pure function of that one string,
 * and `converge` / `ship` must read them from here rather than re-spelling them:
 * a path spelled twice is a path that eventually disagrees with itself.
 *
 * The caller is expected to hand in a composition name that exists in the
 * `compositions` config — the create/update handler is what enforces that, and
 * membership there also means the name passed `assertCompositionName`'s
 * `[a-z0-9-]` shape, which is what makes it safe as a unix user, a path segment
 * and a systemd instance name. This module deliberately does not re-validate
 * (and so does not import build-time tooling into a `core/` the browser loads).
 */

/**
 * The shebang every generated remote script opens with.
 *
 * A remote-host interpreter location, hence here rather than inlined at the two
 * template literals that emit a script. Both scripts are in fact invoked as
 * `bash <path>` over SSH, so this line is documentation rather than the thing
 * that selects the interpreter — it matters because a failed run deliberately
 * *leaves the script on the host* for a human to read, and a script found in
 * `/tmp` should say what runs it.
 */
export const REMOTE_SCRIPT_SHEBANG = "#!/usr/bin/env bash";

/** Root of every install. One dir per composition, never shared. */
export const INSTALL_ROOT = "/srv/equin";

/**
 * The templated systemd unit — ONE file for every composition, so nothing
 * per-instance may appear in it (`%i` is the only thing systemd expands).
 * Per-deployment values go in {@link InstallLayout.envFile} instead.
 */
export const UNIT_TEMPLATE_PATH = "/etc/systemd/system/equin@.service";

/** Where converge writes each composition's Caddy site block. */
export const CADDY_SITES_DIR = "/etc/caddy/sites";

/**
 * systemd's instance-name specifier — the ONE thing systemd expands in
 * {@link UNIT_TEMPLATE_PATH}.
 *
 * Converge renders the unit template's paths as
 * `deriveInstall(SYSTEMD_INSTANCE)`, i.e. the layout of a *symbolic*
 * composition. That is what makes the template and the real instance's paths
 * agree **by construction**: `svc-%i` / `/srv/equin/%i/env` are not a second,
 * hand-spelled copy of the layout that could drift from the one `ship` writes
 * into — they are the same function of a different name.
 */
export const SYSTEMD_INSTANCE = "%i";

/**
 * The bind host the gateway listens on, on a deployed host. Not configurable:
 * Caddy terminates TLS in front and proxies to loopback, so a gateway reachable
 * off-box is a hole rather than a feature — and the whole point of carrying a
 * bind host at all is that it cannot be forgotten.
 */
export const LOOPBACK_HOST = "127.0.0.1";

/** Default `loopbackPort` for a new deployment (the table's default too). */
export const DEFAULT_LOOPBACK_PORT = 9100;

/** The paths and names one install occupies on its host. All derived. */
export interface InstallLayout {
  /** The composition name every other field is derived from. */
  readonly compositionId: string;
  /** Unprivileged run user. Derived, so it can never be `root`. */
  readonly runUser: string;
  /** systemd instance, e.g. `equin@website.service`. */
  readonly unit: string;
  /** `/srv/equin/<c>` — the install root. */
  readonly installDir: string;
  /** Immutable per-run bundle dirs live under here. */
  readonly releasesDir: string;
  /** The activation pointer: flipping this symlink IS the deploy. */
  readonly currentLink: string;
  /** `EQUIN_RELEASE_DIR` — the self-extractor's cache. */
  readonly runtimeDir: string;
  /** `EQUIN_DIR` — postgres cluster, config, logs. The isolation boundary. */
  readonly dataDir: string;
  /** `EnvironmentFile` (0600, `root:svc-<c>`) carrying the per-install values. */
  readonly envFile: string;
  /** This composition's Caddy site block. */
  readonly caddySitePath: string;
}

/** Derive one composition's whole host layout from its name. */
export function deriveInstall(compositionId: string): InstallLayout {
  const installDir = `${INSTALL_ROOT}/${compositionId}`;
  return Object.freeze({
    compositionId,
    runUser: `svc-${compositionId}`,
    unit: `equin@${compositionId}.service`,
    installDir,
    releasesDir: `${installDir}/releases`,
    currentLink: `${installDir}/current`,
    runtimeDir: `${installDir}/runtime`,
    dataDir: `${installDir}/data`,
    envFile: `${installDir}/env`,
    caddySitePath: `${CADDY_SITES_DIR}/${compositionId}.caddy`,
  });
}

/** The immutable dir one shipped bundle lands in. */
export function releaseDir(compositionId: string, runId: string): string {
  return `${deriveInstall(compositionId).releasesDir}/${runId}`;
}

/**
 * The fixed name of a release dir's entrypoint symlink — spelled ONCE, because
 * the two places that name it must agree: `ship` creates
 * {@link releaseAppPath}, and the unit's `ExecStart` is
 * {@link currentAppPath}. A disagreement here is a unit that cannot exec.
 */
const APP_ENTRY_NAME = "app";

/**
 * The fixed-name entrypoint symlink ship writes beside the shipped binary.
 *
 * The binary itself is named `<comp>-<target>-<platform>`, which carries the
 * platform and so cannot be reconstructed from systemd's `%i`. The unit execs
 * `current/app` instead; the symlink is created at upload, before the `current`
 * flip, so `current` never points at a dir the unit cannot exec.
 */
export function releaseAppPath(compositionId: string, runId: string): string {
  return `${releaseDir(compositionId, runId)}/${APP_ENTRY_NAME}`;
}

/**
 * The unit's `ExecStart`: the entrypoint symlink *through* the activation
 * pointer, so flipping `current` is what changes which build runs — the unit
 * file itself never mentions a release.
 */
export function currentAppPath(compositionId: string): string {
  return `${deriveInstall(compositionId).currentLink}/${APP_ENTRY_NAME}`;
}

/**
 * Where a deployment is reachable from outside its host, one URL per hostname.
 *
 * `https://` and nothing else: converge writes a Caddy site block per hostname
 * and Caddy terminates TLS in front of the loopback gateway, so a deployed
 * hostname is an HTTPS origin by construction — there is no plaintext port to
 * offer as an alternative. This mirrors what `./equin deploy ship` prints
 * at the end of a successful run, and belongs here for the same reason every
 * other remote-host fact does: a URL spelled in two places eventually disagrees
 * with itself.
 *
 * A wildcard hostname (`*.example.com`, which the endpoint's `HostnameSchema`
 * allows because Caddy serves wildcard sites natively) is passed through
 * verbatim, exactly as the CLI prints it. It names a *family* of origins rather
 * than one, so there is no honest concrete URL to substitute, and inventing one
 * would be worse than showing what was configured.
 */
export function publicUrls(hostnames: readonly string[]): string[] {
  return hostnames.map((hostname) => `https://${hostname}`);
}

/**
 * What to say when a deployment has no hostname at all — the CLI's own sentence
 * for the same state, so the pane and the terminal agree. Not an empty render:
 * "no public URL" is an answer about the deployment, and a surface that just
 * shows nothing answers it by implication.
 */
export function loopbackOnlySentence(loopbackPort: number): string {
  return `No hostname on this deployment — reachable only at ${listenAddress(
    loopbackPort,
  )} on the host.`;
}

/**
 * The `EQUIN_LISTEN` value for a deployment — the single runtime override
 * of the gateway's bind address, rendered into the `env` file by converge. The
 * loopback host is baked in here rather than passed, so a converge run cannot
 * emit a wildcard bind by omission.
 */
export function listenAddress(loopbackPort: number): string {
  return `${LOOPBACK_HOST}:${loopbackPort}`;
}
