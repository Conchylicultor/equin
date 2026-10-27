// The identifiers built from the product's old name that are KEPT for good.
//
// Each one is stored state (a database, a keychain item, a lock file, a key in
// someone's localStorage, a line in a remote's authorized_keys) or a contract
// that processes on different versions rely on (a lock dir every checkout
// shares, a header a stale tab keeps sending). Renaming one splits or loses
// that state, so it stays — and it is spelled HERE and nowhere else: every
// consumer imports it, and `product-name:legacy-id` rejects the old name in any
// other tracked file.
//
// A name that is produced and consumed by the same build (a package scope, a
// camelCase identifier, a temp prefix) is not kept: it is renamed to
// `PRODUCT_NAME`. The decision, family by family:
// research/2026-10-25-global-equin-internal-identifiers.md.

export const LEGACY_IDS = {
  /** The main namespace: its database, socket, logs and state dirs, the main composition id. */
  mainNamespace: "singularity",
  /** The embedded cluster's Postgres role. */
  pgUser: "singularity",
  /** The cluster's base database (every worktree DB is forked from it). */
  pgBaseDatabase: "singularity",
  /** The macOS keychain service holding the secrets master key. */
  keychainService: "singularity",
  /** The gateway's code-signing identifier (TCC grants are keyed on it). */
  codesignIdentifier: "dev.singularity.gateway",
  /** The gateway's launchd / systemd label before the data-dir migration (`./equin data-dir migrate`). */
  launchdLabel: "dev.singularity.gateway",
  /** The data root's dir name under the home dir before the data-dir migration (`~/<dir>`). */
  dataDirName: ".singularity",
  /** The trailer naming the conversation a commit came from. */
  conversationTrailer: "Singularity-Conversation",
  /** The trailer naming the push a commit landed with. */
  pushTrailer: "Singularity-Push",
  /** The section of every checkout's git config the app writes keys under. */
  gitConfigSection: "singularity",
  /** The domain of the auto-assigned commit e-mail (`<x>@<domain>`). */
  autoIdentityDomain: "singularity.invalid",
  /** The git-dir dir holding the host-wide semaphore slot files. */
  gitLockDir: "singularity-locks",
  /** The git-dir dir holding conflict-marker records of a rebase. */
  mergeMarkersDir: "singularity-merge-markers",
  /** The ref pushed (and deleted) to probe write access to a remote. */
  writeProbeRef: "refs/heads/singularity-write-probe",
  /** The lock reason of an agent worktree (`git worktree lock --reason`). */
  worktreeLockReason: "singularity agent worktree",
  /** The lock reason of a spare (pre-created) worktree. */
  spareLockReason: "singularity-spare",
  /** The prefix of the app's own DB objects (`__<p>_migrations`, `<p>_mark_superseded()`, GUC `<p>.superseded`). */
  dbObjectPrefix: "singularity",
  /** The tag of the markers in migration SQL (`-- <tag>:snapshot`, `-- <tag>:phase`, …). */
  migrationMarker: "singularity",
  /** The prefix of the app's HTTP headers (`<p>origin`, `<p>agent-write`, …). */
  headerPrefix: "x-singularity-",
  /** The prefix of the app's drag-and-drop MIME types. */
  mimePrefix: "application/x-singularity-",
  /** The prefix of browser-side keys and names: localStorage, IndexedDB, SharedWorker / port names, window messages. */
  browserKeyPrefix: "singularity",
  /** The prefix of the globals content-addressed web artifacts read (`<p>GRAPH__`, `<p>COMMIT__`). */
  artifactGlobalPrefix: "__SINGULARITY_",
  /** The OAuth popup's window name. */
  authPopupName: "singularity-auth",
  /** The message the OAuth callback page posts to its opener. */
  authCompleteMessage: "singularity.auth.complete",
  /** The agent browser's Playwright endpoint name. */
  agentBrowserName: "singularity-agent-browser",
  /** The backup source holding the platform's own data. */
  backupPlatformSource: "singularity-platform",
  /** The file explorer's place for the repo checkout. */
  fileExplorerPlace: "singularity",
  /** The comment of a deploy SSH key (`<p><server id>`). */
  deployKeyCommentPrefix: "singularity-deploy-",
  /** The legacy CLI name, still a shim at the repo root. */
  cliShim: "singularity",
  /** The default checkout dir of a fresh install (`~/<dir>`). */
  defaultCheckoutDir: "singularity",
  /** The backups dir under the home dir (`~/.backups/<dir>`). */
  backupsDirName: "singularity",
  /** What the app's environment variables were named with (`<p>DIR`, …), read beside `EQUIN_*` during the rename window. */
  envPrefix: "SINGULARITY_",
  /** The GitHub repository. */
  githubRepo: "Conchylicultor/singularity",
} as const;

export type LegacyIdKey = keyof typeof LEGACY_IDS;

export interface LegacyIdNote {
  /** Why it is kept: what stores it, or which processes on different versions read it. */
  readonly kept: string;
  /**
   * Repo files that cannot import this leaf (Go, Rust, shell, a standalone
   * script) and so spell the value themselves. A mirror must keep containing it
   * — `product-name:legacy-id` asserts it — and is the only file outside this
   * leaf where a line naming it may stand.
   */
  readonly mirrors?: readonly string[];
}

export const LEGACY_ID_NOTES: Readonly<Record<LegacyIdKey, LegacyIdNote>> = {
  mainNamespace: {
    kept: "the main namespace's database, socket, data dirs and stored rows",
    mirrors: [
      "gateway/proxy.go",
      "gateway/worktree.go",
      "install.sh",
      "plugins/menu-bar/rust/src/cli.rs",
      "sidequests/claude-web/session-picker.sh",
      "sidequests/clean-install/steps.sh",
      "sidequests/clean-install/steps-install.sh",
    ],
  },
  pgUser: {
    kept: "the role every worktree database is owned by",
    mirrors: [
      "plugins/database/plugins/pgbouncer/scripts/start.ts",
      "sidequests/clean-install/steps.sh",
    ],
  },
  pgBaseDatabase: {
    kept: "the cluster's existing base database",
    mirrors: [
      "sidequests/claude-web/session-picker.sh",
      "sidequests/clean-install/steps.sh",
    ],
  },
  keychainService: {
    kept: "holds the secrets master key; losing it loses every secret",
  },
  codesignIdentifier: {
    kept: "TCC grants are keyed on it; renaming re-prompts every permission",
  },
  launchdLabel: {
    kept: "the installed service of an install not yet migrated; the gateway's login service stays bound to it while its definition is installed, until `./equin data-dir migrate` relabels it",
  },
  dataDirName: {
    kept: "the data root of an install not yet migrated; it is used while it exists, until `./equin data-dir migrate` moves it (paths/core dataRootLayout)",
    mirrors: [
      "gateway/dataroot.go",
      "install.sh",
      "sidequests/monitors/fd/fd-monitor.sh",
      "sidequests/clean-install/run.sh",
      "sidequests/clean-install/steps-migrate.sh",
    ],
  },
  conversationTrailer: {
    kept: "written into every commit in history",
    mirrors: [".githooks/prepare-commit-msg"],
  },
  pushTrailer: { kept: "written into every commit in history" },
  gitConfigSection: {
    kept: "keys in every checkout's .git/config, read by mixed versions",
  },
  autoIdentityDomain: { kept: "in the author e-mail of existing commits" },
  gitLockDir: {
    kept: "shared by every worktree on mixed versions; renaming splits the lock",
  },
  mergeMarkersDir: {
    kept: "shared by every worktree on mixed versions",
    mirrors: [
      ".githooks/post-rewrite",
      "plugins/framework/plugins/cli/scripts/regen-claudemd.sh",
      "plugins/framework/plugins/cli/scripts/regen-generated.sh",
      "plugins/framework/plugins/cli/scripts/regen-migrations.sh",
    ],
  },
  writeProbeRef: { kept: "a ref name older checkouts may leave behind" },
  worktreeLockReason: { kept: "written into existing worktrees' lock files" },
  spareLockReason: {
    kept: "written into existing spares' lock files, and how a spare is recognised",
  },
  dbObjectPrefix: {
    kept: "tables, functions and settings in every database",
    mirrors: [
      "sidequests/claude-web/session-picker.sh",
      "sidequests/clean-install/steps.sh",
    ],
  },
  migrationMarker: { kept: "in every committed migration's SQL" },
  headerPrefix: { kept: "a tab open across a deploy keeps sending it" },
  mimePrefix: { kept: "a drag between tabs on different versions" },
  browserKeyPrefix: {
    kept: "browser-local data (drafts, tab ids, IndexedDB) and names tabs on different versions share",
  },
  artifactGlobalPrefix: {
    kept: "content-addressed artifacts from older builds read these globals",
  },
  authPopupName: {
    kept: "the popup and its opener can be on different versions",
  },
  authCompleteMessage: {
    kept: "the callback page and its opener can be on different versions",
  },
  agentBrowserName: { kept: "agent sessions on older versions attach by it" },
  backupPlatformSource: { kept: "backup run rows and archive layouts" },
  fileExplorerPlace: { kept: "stored place selections" },
  deployKeyCommentPrefix: {
    kept: "in the authorized_keys of every configured server",
  },
  cliShim: {
    kept: "the `./singularity` shim old transcripts and muscle memory call",
    mirrors: ["plugins/framework/plugins/cli/package.json"],
  },
  defaultCheckoutDir: {
    kept: "existing installs' checkout dir, which is never moved (git worktrees store absolute gitdirs); install.sh clones new installs to ~/equin",
    mirrors: [
      ".vscode/settings.json",
      "sidequests/claude-web/com.epot.claude-new.plist",
      "sidequests/claude-web/com.epot.claude-picker.plist",
      "sidequests/monitors/fd/com.epot.fd-monitor.plist",
      "sidequests/clean-install/steps.sh",
      "sidequests/clean-install/steps-migrate.sh",
    ],
  },
  backupsDirName: {
    kept: "the local backups of an install not yet migrated; used while it exists, until `./equin data-dir migrate` moves it (paths/core backupsDir)",
  },
  envPrefix: {
    kept: "installed plists, older gateways and backends, agent hooks and operators' dotfiles still set or read the old names; both are read and written until a later step drops them (research/2026-10-25-global-equin-env-vars.md)",
    mirrors: [
      "gateway/env.go",
      ".claude/settings.json",
      ".githooks/prepare-commit-msg",
      ".githooks/post-rewrite",
      ".mcp.json",
      "plugins/framework/plugins/cli/plugins/doctor/doctor.sh",
      "sidequests/claude-web/session-picker.sh",
    ],
  },
  githubRepo: { kept: "the repository keeps its name (user decision)" },
};
