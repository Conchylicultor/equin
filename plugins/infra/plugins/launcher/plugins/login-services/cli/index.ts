// Shared CLI machinery, not a command (no default export): this host's
// service manager alone — the launchd / systemd driver over one service's
// definition — without the machine barrel's backend half (the follow-main
// reaction, the declared-services registry), whose closure reaches the server
// barrels `./equin build` regenerates (`cli:codegen-manifests-not-frozen`).
export { loginService } from "../machine/internal/host";
export type {
  InstalledJob,
  LoginService,
} from "../machine/internal/login-service";
