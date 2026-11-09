import type { Dep, DepSource, Ready } from "@plugins/infra/plugins/deps/deps";
import type { BundleSigner } from "@plugins/infra/plugins/codesign/deps";
import {
  executableEnv,
  type AppComponent,
  type ComponentBuild,
  type LoginServiceId,
  type LoginServiceJob,
  type LoginServiceSchedule,
  type LoginServiceSession,
  type ServiceExecutable,
} from "../../core";
import type { LoginServiceManager } from "./login-service";

/** What a declaration's `spec` computes from its installed dependency. */
export type LoginServiceRun = Omit<LoginServiceJob, "description">;

/**
 * The labels of the services a declaration `refersTo`, keyed as it keys
 * them — each the label its service is bound to on this machine (a legacy
 * one until a relabel, `LoginServiceId.installedAs`), resolved by the
 * reconcile before `spec` runs.
 */
export type ReferredLabels<R extends string = string> = Readonly<
  Record<R, string>
>;

export interface DefineLoginServiceSpec<
  S extends DepSource,
  R extends string = never,
> {
  /**
   * The service label, reverse-DNS (`dev.equin.menu-bar`): the launchd
   * `Label` and plist name, the systemd unit name. Unique across the
   * composition.
   */
  id: string;
  /** The declaring plugin's path (`menu-bar`), as a user reads it in `start`'s output. */
  owner: string;
  /** One line, as a user reads it in `systemctl status`. */
  description: string;
  session: LoginServiceSession;
  /** When it runs: always (absent), or periodically (`LoginServiceId.schedule`). */
  schedule?: LoginServiceSchedule;
  /**
   * The OSes it exists on (`process.platform`); absent: every one. A service
   * that only means something on one OS (a macOS disk monitor) is not
   * declared anywhere else — `start`, `stop` and main's boot never see it.
   */
  platforms?: readonly NodeJS.Platform[];
  /**
   * The dependency the service runs. `start` ensures it from the main checkout
   * and holds it, so the deps sweep never deletes the binary the job names.
   */
  dep: Dep<S>;
  /**
   * The program it runs, as a component of the equin app: on macOS an
   * executable inside `equin.app`, so its permissions are the app's
   * (`macos-app.ts`). `build` says which file of the installed dependency that
   * is (and the app icon, when this component brings it).
   */
  executable: AppComponent & {
    build(ready: Ready<S>): ComponentBuild;
  };
  /**
   * Other login services whose label the job names (the menu-bar helper's
   * Start button kicks the gateway's), keyed by a name of the declaration's
   * choosing. `spec` receives each one's BOUND label under that key — data
   * resolved before it runs, so `spec` never looks a binding up itself.
   */
  refersTo?: Readonly<Record<R, LoginServiceId>>;
  /**
   * How to run it, from the installed dependency — a `Ready`, so a job that
   * never ensured its binary does not compile — `executable`, the path the
   * program runs from (inside the app bundle on macOS): the only spelling of
   * argv[0], so a job cannot run the build from the deps cache by mistake —
   * `labels`, the bound label of every service it `refersTo`, and `signer`,
   * how the service signs bundles of its own with this machine's identity
   * (null off macOS; resolved before `spec` runs, so a changed identity is a
   * changed job).
   */
  spec(
    ready: Ready<S>,
    executable: string,
    labels: ReferredLabels<R>,
    signer: BundleSigner | null,
  ): LoginServiceRun;
}

/**
 * A declared login service: a plugin's per-user OS service that `./equin start`
 * registers and starts next to the gateway, and `./equin stop` stops.
 * Collected from every plugin's `login-services/index.ts` default export.
 */
export interface LoginServiceDeclaration<
  S extends DepSource = DepSource,
> extends Readonly<Omit<DefineLoginServiceSpec<S>, "spec" | "refersTo">> {
  readonly _brand: "LoginServiceDeclaration";
  readonly refersTo: Readonly<Record<string, LoginServiceId>>;
  spec(
    ready: Ready<S>,
    executable: string,
    labels: ReferredLabels,
    signer: BundleSigner | null,
  ): LoginServiceRun;
}

const LABEL = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

/**
 * Declare a login service. Export it from the plugin's
 * `login-services/index.ts` and list it in that file's `default` array; the
 * registry finds it, and neither `start` nor `stop` names it.
 */
export function defineLoginService<
  S extends DepSource,
  R extends string = never,
>(spec: DefineLoginServiceSpec<S, R>): LoginServiceDeclaration<S> {
  if (!LABEL.test(spec.id)) {
    throw new Error(
      `defineLoginService: id ${JSON.stringify(spec.id)} must be a reverse-DNS label matching ${LABEL}`,
    );
  }
  // `spec` reads `labels` by the keys of `refersTo`, and the reconcile builds
  // `labels` from exactly those keys (`referredLabels`).
  return {
    ...spec,
    refersTo: spec.refersTo ?? {},
    _brand: "LoginServiceDeclaration",
  };
}

/** The service a manager is asked about — known without ensuring anything. */
export function loginServiceId(decl: LoginServiceDeclaration): LoginServiceId {
  return {
    label: decl.id,
    session: decl.session,
    ...(decl.schedule === undefined ? {} : { schedule: decl.schedule }),
  };
}

/**
 * The bound label of every service `decl` refers to, keyed as it keys them:
 * what its `spec` reads. Asked of `manager` now, so a relabel since the last
 * reconcile renders a changed job (and reloads it).
 */
export async function referredLabels(
  manager: LoginServiceManager,
  decl: LoginServiceDeclaration,
): Promise<ReferredLabels> {
  const entries = await Promise.all(
    Object.entries(decl.refersTo).map(
      async ([key, id]) => [key, (await manager.service(id)).id.label] as const,
    ),
  );
  return Object.fromEntries(entries);
}

/**
 * The job to write, from the declaration's installed dependency, where its
 * executable runs from, the bound labels it refers to
 * ({@link referredLabels}) and this machine's bundle signer. A bundled executable's build is named in the
 * job's environment ({@link executableEnv}): its path is stable, so that is
 * what makes a rebuilt component a changed job.
 */
export function loginServiceJob<S extends DepSource>(
  decl: LoginServiceDeclaration<S>,
  ready: Ready<S>,
  executable: ServiceExecutable,
  labels: ReferredLabels,
  signer: BundleSigner | null,
): LoginServiceJob {
  const run = decl.spec(ready, executable.path, labels, signer);
  return {
    description: decl.description,
    ...run,
    env: { ...run.env, ...executableEnv(executable) },
  };
}

/**
 * The `holdDep` holder keeping the service's binary from the deps sweep: one
 * per service, so a newer `start` moves exactly that hold.
 */
export function loginServiceHolder(decl: LoginServiceDeclaration): string {
  return `login-service-${decl.id.replaceAll(".", "-")}`;
}

export function isLoginServiceDeclaration(
  value: unknown,
): value is LoginServiceDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<LoginServiceDeclaration>)._brand ===
      "LoginServiceDeclaration"
  );
}
