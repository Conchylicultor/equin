import type { Dep, DepSource, Ready } from "@plugins/infra/plugins/deps/deps";
import type {
  LoginServiceId,
  LoginServiceJob,
  LoginServiceSession,
} from "../../core";

/** What a declaration's `spec` computes from its installed dependency. */
export type LoginServiceRun = Omit<LoginServiceJob, "description">;

export interface DefineLoginServiceSpec<S extends DepSource> {
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
  /**
   * The dependency the service runs. `start` ensures it from the main checkout
   * and holds it, so the deps sweep never deletes the binary the job names.
   */
  dep: Dep<S>;
  /** How to run it, from the installed dependency — a `Ready`, so a job that never ensured its binary does not compile. */
  spec(ready: Ready<S>): LoginServiceRun;
}

/**
 * A declared login service: a plugin's per-user OS service that `./equin start`
 * registers and starts next to the gateway, and `./equin stop` stops.
 * Collected from every plugin's `login-services/index.ts` default export.
 */
export interface LoginServiceDeclaration<
  S extends DepSource = DepSource,
> extends Readonly<Omit<DefineLoginServiceSpec<S>, "spec">> {
  readonly _brand: "LoginServiceDeclaration";
  spec(ready: Ready<S>): LoginServiceRun;
}

const LABEL = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

/**
 * Declare a login service. Export it from the plugin's
 * `login-services/index.ts` and list it in that file's `default` array; the
 * registry finds it, and neither `start` nor `stop` names it.
 */
export function defineLoginService<S extends DepSource>(
  spec: DefineLoginServiceSpec<S>,
): LoginServiceDeclaration<S> {
  if (!LABEL.test(spec.id)) {
    throw new Error(
      `defineLoginService: id ${JSON.stringify(spec.id)} must be a reverse-DNS label matching ${LABEL}`,
    );
  }
  return { ...spec, _brand: "LoginServiceDeclaration" };
}

/** The service a manager is asked about — known without ensuring anything. */
export function loginServiceId(decl: LoginServiceDeclaration): LoginServiceId {
  return { label: decl.id, session: decl.session };
}

/** The job to write, from the declaration's installed dependency. */
export function loginServiceJob<S extends DepSource>(
  decl: LoginServiceDeclaration<S>,
  ready: Ready<S>,
): LoginServiceJob {
  return { description: decl.description, ...decl.spec(ready) };
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
