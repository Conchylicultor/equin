/**
 * The converge script: the whole convergent host state for one deployment, as
 * one idempotent shell script generated from the deployment row.
 *
 * It lives here rather than in `converge.ts` for one reason: a ~200-line shell
 * template whose only execution path is a remote host 15 minutes and a 100MB
 * round trip away is a template whose typos are discovered in production.
 * Everything in this file is a pure function of plain values, so
 * `converge-script.test.ts` can `bash -n` the result and exercise
 * {@link PUT_HELPER_SH} against real files.
 *
 * ### The idempotence contract
 *
 * Two properties, and the second depends on the first:
 *
 * 1. **No step claims `[=]` without having compared.** Every generated file
 *    lands through `put`, which replaces the target only when the bytes differ
 *    — so an unchanged file keeps its old mtime, and the `[=]`/`[~]` in the log
 *    is derived rather than asserted. The steps that are not file writes (the
 *    packages, Caddy's reload, ufw) read the host's own state first for the
 *    same reason.
 * 2. **The restart is gated on the host's state, not on this run's memory.** It
 *    fires when the RUNNING process predates its configuration — which is a
 *    no-op on an unchanged host, and still repairs the install when a previous
 *    converge wrote a new `env` and died before restarting it.
 *
 * Design: `research/2026-07-31-deploy-converge-idempotence.md`, amending D3 of
 * `research/2026-07-29-global-composition-production-deployment.md`.
 */
import {
  CADDY_SITES_DIR,
  INSTALL_ROOT,
  REMOTE_SCRIPT_SHEBANG,
  SYSTEMD_INSTANCE,
  UNIT_TEMPLATE_PATH,
  currentAppPath,
  deriveInstall,
  listenAddress,
  type InstallLayout,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { HOST_ONLY_PREFIX } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";

/** Shell single-quote one value for safe interpolation into the script. */
export function sq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * `put` — the ONE way a generated file lands on the host.
 *
 * The caller stages its content at `$1.new`; this applies the mode and owner,
 * then replaces the target **only when the content actually differs**. Two
 * things fall out of that, and converge depends on both:
 *
 * - The log stops lying. `[=]` is the return value of a comparison, not a
 *   string the step prints because it assumes it changed nothing.
 * - The mtime becomes meaningful. An unchanged file keeps its old timestamp,
 *   which is what the restart gate reads to decide whether the running process
 *   is older than its configuration.
 *
 * Mode and owner are re-applied either way, so a hand-`chmod`ded file still
 * converges back without counting as a content change. A missing target makes
 * `cmp` fail, i.e. "changed" — which is correct on a bare host.
 *
 * Exported as its own constant so the test exercises the exact text that ships.
 */
export const PUT_HELPER_SH = `# Returns 0 when the file changed, 1 when the host was already correct.
put() {
  _t=$1
  _mode=$2
  _own=$3
  chmod "$_mode" "$_t.new"
  [ "$_own" = "-" ] || chown "$_own" "$_t.new"
  if cmp -s "$_t.new" "$_t" 2>/dev/null; then
    rm -f "$_t.new"
    chmod "$_mode" "$_t"
    [ "$_own" = "-" ] || chown "$_own" "$_t"
    return 1
  fi
  mv -f "$_t.new" "$_t"
  return 0
}`;

/**
 * The restart gate: fire iff the RUNNING process predates its configuration.
 *
 * A state comparison rather than a memory of what this run did, which is what
 * makes it both a no-op on an unchanged host and a repair on a drifted one — a
 * converge that wrote a new `env` and then died before restarting leaves an
 * install serving the old address, and a "did I change something just now" flag
 * would never fix it. Ship restarts the unit itself, so the process is newer
 * than both files and a converge after a ship correctly does nothing.
 *
 * Reads `$ENV_FILE`, `$UNIT_PATH` and `$UNIT`. Exported as its own constant so
 * `converge-script.test.ts` can run the exact text that ships against stubbed
 * `systemctl` / `stat` / `/proc/stat` and assert the whole decision table.
 */
export const RESTART_GATE_SH = `newest_config=0
for f in "$ENV_FILE" "$UNIT_PATH"; do
  # Written as an \`if\` rather than \`[ … ] && x=$m\`, whose non-zero status on
  # the false branch would trip \`set -e\`.
  m="$(stat -c %Y "$f")"
  if [ "$m" -gt "$newest_config" ]; then newest_config="$m"; fi
done
if ! systemctl is-active --quiet "$UNIT"; then
  echo "[=] $UNIT is enabled but not running — nothing shipped yet"
else
  # Wall-clock start time as (kernel boot time + the unit's monotonic start),
  # deliberately NOT \`date -d ExecMainStartTimestamp\`: that string carries
  # locale-dependent weekday and month names, which would make this gate depend
  # on the environment systemctl happens to run in. PROC_STAT is /proc/stat
  # everywhere except in the test that exercises this block.
  mono="$(systemctl show -p ExecMainStartTimestampMonotonic --value "$UNIT")"
  btime="$(awk '/^btime /{print $2}' "\${PROC_STAT:-/proc/stat}")"
  if [ -z "$mono" ] || [ "$mono" = "0" ]; then
    started=0   # cannot prove the running process is current → restart it
  else
    started=$(( btime + mono / 1000000 ))
  fi
  # Strictly greater: a config written in the SAME second as the restart is
  # treated as current, because that is overwhelmingly this script's own write
  # followed by its own restart. The alternative (>=) would restart on every
  # single run for any install whose two landed in one second.
  if [ "$newest_config" -gt "$started" ]; then
    systemctl restart "$UNIT"
    echo "[~] restarted $UNIT — its configuration is newer than the running process"
  else
    echo "[=] $UNIT is current with $ENV_FILE and $UNIT_PATH"
  fi
fi`;

/**
 * The systemd unit — ONE template file for every composition, so nothing
 * per-instance may appear in it. Its paths are `deriveInstall("%i")`, the same
 * function that derives the real instance's paths.
 *
 * `EQUIN_RELEASE_DIR` is explicit because `PrivateTmp=yes` gives the service its
 * own `/tmp`: without it the self-extractor falls back to `tmpdir()` and
 * re-extracts the whole bundle on every boot.
 */
export function unitTemplate(): string {
  const t = deriveInstall(SYSTEMD_INSTANCE);
  return `[Unit]
Description=equin composition ${SYSTEMD_INSTANCE}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${t.runUser}
ExecStart=${currentAppPath(SYSTEMD_INSTANCE)}
EnvironmentFile=${t.envFile}
Environment=SINGULARITY_DIR=${t.dataDir}
Environment=EQUIN_RELEASE_DIR=${t.runtimeDir}
Restart=always
RestartSec=2
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
`;
}

/** This deployment's Caddy site block: TLS in front, plain HTTP on loopback. */
export function caddySite(hostnames: string[], loopbackPort: number): string {
  // No `header_up Host`: each install runs its OWN gateway with
  // `-default-namespace <composition>`, and the gateway's `parseWorktree`
  // yields no worktree for anything not ending in `.localhost` — so a public
  // Host falls straight through to the default namespace. Caddy handles ACME,
  // renewal and WebSocket upgrades natively.
  //
  // `encode` and the asset `Cache-Control` belong HERE rather than in the app:
  // the backend serves the web dist uncompressed and unlabelled, so without
  // these every visitor pays ~4x the bytes and every REPEAT visitor re-downloads
  // the whole bundle. Caddy is the only layer that sees the finished response,
  // and it is generated, so a deployment cannot forget them.
  //
  // The `immutable` year is safe for `/assets/*` ONLY: vite content-hashes those
  // filenames, so a changed file is a changed URL. Everything else (the HTML
  // shell, the unhashed root icons) is deliberately left revalidating — caching
  // index.html for a year would pin visitors to a stale build forever.
  //
  // `respond <HOST_ONLY_PREFIX>* 404` refuses the box-only routes (analytics
  // reports, read over SSH from the local deploy app) before they reach the
  // gateway. Caddy's fixed directive order runs `respond` ahead of
  // `reverse_proxy`, so its position in the block is not what makes it win.
  // `hostOnly()` on the backend is the second, independent guard.
  return `${hostnames.join(", ")} {
\tencode zstd gzip
\trespond ${HOST_ONLY_PREFIX}* 404
\theader /assets/* Cache-Control "public, max-age=31536000, immutable"
\treverse_proxy ${listenAddress(loopbackPort)}
}
`;
}

/**
 * The whole convergent host state, as one idempotent script.
 *
 * Every step is written so that a second run changes nothing and a drifted host
 * is repaired: `id -u` before `useradd`, `install -d` (which re-applies owner
 * and mode), `put` for every file write, package installs guarded on what is
 * actually present, and ufw / Caddy's reload / the unit restart each gated on a
 * read of the host's own state.
 */
export function convergeScript(opts: {
  install: InstallLayout;
  hostnames: string[];
  loopbackPort: number;
  sshPort: number;
  sshUser: string;
}): string {
  const { install, hostnames, loopbackPort, sshPort, sshUser } = opts;
  const caddyfile = "/etc/caddy/Caddyfile";
  const keyring = "/usr/share/keyrings/caddy-stable-archive-keyring.gpg";
  const sourceList = "/etc/apt/sources.list.d/caddy-stable.list";
  // The signed-by path is spelled INSIDE the apt source line, so it is derived
  // from the same constant rather than typed twice.
  const debLine = `deb [signed-by=${keyring}] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main`;
  const firewallRule = `${sshPort},80,443/tcp`;

  return `${REMOTE_SCRIPT_SHEBANG}
# GENERATED by \`./equin deploy converge\` — do NOT edit on the host.
# It is regenerated from the deployment row and re-uploaded on every converge,
# so any edit here is silently discarded. Change the deployment instead.
set -euo pipefail

# Everything this script says goes to stderr: \`sshRun\`'s failure result carries
# stderr ONLY, so progress written to stdout would be dropped on exactly the run
# a human needs to read. Command substitutions are unaffected (each sets up its
# own stdout), which is what keeps \`$(...)\` reads below working.
exec 1>&2

C=${sq(install.compositionId)}
RUN_USER=${sq(install.runUser)}
UNIT=${sq(install.unit)}
INSTALL_ROOT=${sq(INSTALL_ROOT)}
INSTALL_DIR=${sq(install.installDir)}
RELEASES_DIR=${sq(install.releasesDir)}
RUNTIME_DIR=${sq(install.runtimeDir)}
DATA_DIR=${sq(install.dataDir)}
ENV_FILE=${sq(install.envFile)}
UNIT_PATH=${sq(UNIT_TEMPLATE_PATH)}
CADDYFILE=${sq(caddyfile)}
CADDY_SITES=${sq(CADDY_SITES_DIR)}
SITE=${sq(install.caddySitePath)}
CADDY_KEYRING=${sq(keyring)}
CADDY_LIST=${sq(sourceList)}
FIREWALL_RULE=${sq(firewallRule)}

# Converge runs as the server's LOGIN user because it creates users and writes
# /etc. The RUN user is a different, unprivileged, derived one — that split is
# the whole point, so say so loudly if the login user is not root.
if [ "$(id -u)" -ne 0 ]; then
  echo "converge needs root; the server's sshUser is ${sshUser}" >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive

${PUT_HELPER_SH}

# ── 1. The run user. Derived from the composition name, never read from a
#       field, so it can never be root — which is what makes initdb legal.
if id -u "$RUN_USER" >/dev/null 2>&1; then
  echo "[=] run user $RUN_USER exists"
else
  useradd --system --create-home "$RUN_USER"
  echo "[+] created run user $RUN_USER"
fi

# ── 2. The dir layout. \`install -d\` re-applies owner and mode on every run, so
#       a hand-chowned dir converges back — and changes nothing observable (no
#       mtime bump) when they already match, which is why this step's "[=]" is
#       true without a comparison of its own. data/ is 750: it holds the
#       Postgres cluster, the config tree and the logs, and only root and the
#       run user have any business there.
install -d -m 755 "$INSTALL_ROOT"
install -d -m 755 -o "$RUN_USER" -g "$RUN_USER" "$INSTALL_DIR" "$RELEASES_DIR" "$RUNTIME_DIR"
install -d -m 750 -o "$RUN_USER" -g "$RUN_USER" "$DATA_DIR"
echo "[=] layout under $INSTALL_DIR"

# ── 3. Base packages. curl is needed by ship's health gate and diffutils by
#       \`put\` above; ufw and the rest are in the Ubuntu base image. All are
#       no-ops when present, and apt does no work at all when nothing is
#       missing. This runs BEFORE the first \`put\` so the helper's one
#       dependency (\`cmp\`) is never an assumption.
missing=""
for p in curl ca-certificates gnupg ufw diffutils; do
  dpkg-query -W -f='\${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing="$missing $p"
done
if [ -n "$missing" ]; then
  echo "[+] installing:$missing"
  apt-get update -qq
  apt-get install -y --no-install-recommends $missing
else
  echo "[=] base packages present"
fi

# ── 4. The EnvironmentFile: the per-DEPLOYMENT values the shared unit template
#       cannot hold. NO secrets — see the plan, §What goes in \`env\`.
#       0600 root:$RUN_USER is safe because systemd (pid 1, root) reads
#       EnvironmentFile BEFORE dropping to User=, so the service never needs
#       read access itself. The umask is scoped to a SUBSHELL so the staged file
#       is never briefly world-readable, without leaking 077 into the 0644 /etc
#       writes below.
(
  umask 077
  {
    echo "# GENERATED by \\\`./equin deploy converge\\\` — do not edit."
    echo "SINGULARITY_LISTEN=${listenAddress(loopbackPort)}"
  } > "$ENV_FILE.new"
)
if put "$ENV_FILE" 600 "root:$RUN_USER"; then
  echo "[~] wrote $ENV_FILE (SINGULARITY_LISTEN=${listenAddress(loopbackPort)})"
else
  echo "[=] $ENV_FILE (SINGULARITY_LISTEN=${listenAddress(loopbackPort)})"
fi

# ── 5. Caddy terminates TLS in front; the gateway stays plain HTTP on
#       loopback. The site file is only written when this deployment declares a
#       hostname — a hostname-less deployment is loopback-only and needs no
#       Caddy. \`caddy_changed\` is what decides whether Caddy is reloaded at
#       all: a reload nobody needs is still a reload of a live edge.
caddy_changed=0
${
  hostnames.length > 0
    ? `# Caddy is NOT in Ubuntu 24.04's archives, so a bare \`apt-get install -y caddy\`
# fails on a fresh image: the official repo goes in first. The key is fetched
# once (a dearmored key is deterministic, so re-fetching would change nothing);
# the source line is staged every run and \`put\` drops it when identical.
if [ ! -s "$CADDY_KEYRING" ]; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o "$CADDY_KEYRING.new"
  chmod 644 "$CADDY_KEYRING.new"
  mv -f "$CADDY_KEYRING.new" "$CADDY_KEYRING"
  echo "[+] caddy apt signing key"
fi
printf '%s\\n' ${sq(debLine)} > "$CADDY_LIST.new"
if put "$CADDY_LIST" 644 -; then
  echo "[~] wrote $CADDY_LIST"
else
  echo "[=] $CADDY_LIST"
fi
if ! command -v caddy >/dev/null 2>&1; then
  echo "[+] installing caddy"
  apt-get update -qq
  apt-get install -y caddy
else
  echo "[=] caddy present"
fi

install -d -m 755 "$CADDY_SITES"
cat > "$SITE.new" <<'EQUIN_CADDY_SITE'
${caddySite(hostnames, loopbackPort)}EQUIN_CADDY_SITE
# 0644: the caddy unit runs as User=caddy and must be able to READ its own site.
if put "$SITE" 644 -; then
  caddy_changed=1
  echo "[~] wrote $SITE"
else
  echo "[=] $SITE"
fi`
    : `if [ -e "$SITE" ]; then
  rm -f "$SITE"
  caddy_changed=1
  echo "[-] removed $SITE (this deployment declares no hostname)"
else
  echo "[=] no Caddy site (this deployment declares no hostname)"
fi`
}

# The root Caddyfile is OURS: converge owns it so the sites dir is genuinely
# imported (the distro default ships an unrelated \`:80\` site and no import we
# can rely on). Written from what is actually in the sites dir, because Caddy
# errors on an import glob that matches nothing — with no sites at all the
# config is deliberately empty, which is exactly "this box serves no hostname".
if command -v caddy >/dev/null 2>&1; then
  if ls "$CADDY_SITES"/*.caddy >/dev/null 2>&1; then
    printf '%s\\n%s\\n' '# GENERATED by ./equin deploy converge — do not edit.' "import $CADDY_SITES/*.caddy" > "$CADDYFILE.new"
  else
    printf '%s\\n' '# GENERATED by ./equin deploy converge — no deployment on this host declares a hostname.' > "$CADDYFILE.new"
  fi
  if put "$CADDYFILE" 644 -; then
    caddy_changed=1
    echo "[~] wrote $CADDYFILE"
  else
    echo "[=] $CADDYFILE"
  fi
  # Validation is a GUARD, not an action, so it runs every time — but silently
  # unless it fails, or a no-op converge would print a wall of "Valid
  # configuration" it did not need to say.
  if ! caddy_check="$(caddy validate --config "$CADDYFILE" 2>&1)"; then
    printf '%s\\n' "$caddy_check" >&2
    exit 1
  fi
  systemctl is-enabled --quiet caddy || systemctl enable caddy >/dev/null 2>&1
  if ! systemctl is-active --quiet caddy; then
    systemctl start caddy
    echo "[+] started caddy"
  elif [ "$caddy_changed" -eq 1 ]; then
    systemctl reload caddy
    echo "[~] reloaded caddy"
  else
    echo "[=] caddy is serving the current config"
  fi
fi

# ── 6. The systemd unit. Reboot survival, crash restart, journald log rotation
#       and the enforced run user all fall out of it — which is why it is the
#       primitive rather than a wrapper script. A CHANGED unit needs the restart
#       in step 8 as much as a changed env does: \`daemon-reload\` alone does
#       nothing for the process already running under the old one.
cat > "$UNIT_PATH.new" <<'EQUIN_UNIT'
${unitTemplate()}EQUIN_UNIT
if put "$UNIT_PATH" 644 -; then
  systemctl daemon-reload
  echo "[~] wrote $UNIT_PATH (daemon-reload)"
else
  echo "[=] $UNIT_PATH"
fi
if systemctl is-enabled --quiet "$UNIT"; then
  echo "[=] $UNIT enabled"
else
  systemctl enable "$UNIT" >/dev/null 2>&1
  echo "[+] enabled $UNIT"
fi

# ── 7. The firewall. ONE multiport rule (a multiport \`ufw allow\` REQUIRES a
#       protocol — bare \`22,80,443\` is rejected) added BEFORE \`--force
#       enable\`, so the SSH session converge is running over survives it. The
#       SSH port comes from the server row, not the literal 22: allowing only 22
#       on a box whose sshd listens elsewhere would lock us out permanently.
#
#       Applying is harmless when it is already applied — but SAYING "[=]"
#       while re-applying is the same dishonesty the file writes above dropped,
#       so the state is read first and the four commands are skipped when the
#       host already matches.
ufw_status="$(ufw status verbose 2>/dev/null || true)"
if printf '%s' "$ufw_status" | grep -qF 'Status: active' \\
  && printf '%s' "$ufw_status" | grep -qF 'Default: deny (incoming), allow (outgoing)' \\
  && printf '%s' "$ufw_status" | grep -qF "$FIREWALL_RULE"; then
  echo "[=] ufw: deny incoming, allow $FIREWALL_RULE"
else
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow "$FIREWALL_RULE" >/dev/null
  ufw --force enable >/dev/null
  echo "[~] ufw: deny incoming, allow $FIREWALL_RULE"
fi

# ── 8. Restart ONLY when the running process predates its configuration.
${RESTART_GATE_SH}

echo "[done] converged $C"
`;
}
