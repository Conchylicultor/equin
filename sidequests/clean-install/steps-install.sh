#!/usr/bin/env bash
# The one-command install (install.sh at the repo root), run as README.md says
# to run it, then checked the way a new user would find out whether it worked.
#
#   sidequests/clean-install/run.sh --steps steps-install.sh
#
# Same step format as steps.sh (see its header): each step_NN_slug echoes the
# commands to run in the guest, with <fn>_DOC and <fn>_TAG. The doc here is
# README.md. Success means every step is `from-docs`, with no
# `undocumented-knowledge` / `documented-elsewhere` / `harness-only` step and
# no `_EXPECT_FAIL` needed.
#
# CLEAN_INSTALL_SH=<path> runs that local install.sh instead of fetching it —
# for verifying the script before it is on main, where the documented URL
# would not find it yet. The script body the guest runs is the same bytes,
# piped to bash the same way.
#
# CLEAN_INSTALL_ARGS="<args>" passes options to install.sh (after
# `bash -s --`), e.g. `--repo /tmp/singularity.bundle` for a snapshot of an
# unpushed tree handed over with run.sh --upload — the same documented
# `--repo` a fork uses.
#
# After install, every step runs in `zsh -l -i`: what a new Terminal window
# is on macOS, so it sees exactly what install.sh added to ~/.zshrc and
# nothing the harness set up.

INSTALL_URL="https://raw.githubusercontent.com/Conchylicultor/singularity/main/install.sh"

step_01_baseline() {
  cat <<'CMD'
sw_vers
uname -m
whoami
echo "SHELL=$SHELL"
for t in git brew mise bun claude; do printf "%-7s %s\n" "$t" "$(command -v $t || echo absent)"; done
xcode-select -p || echo "no Xcode command-line tools"
CMD
}
step_01_baseline_DOC="Nothing — records the guest's starting state."
step_01_baseline_TAG="from-docs"

step_02_one_command() {
  if [[ -n "${CLEAN_INSTALL_SH:-}" ]]; then
    printf "cat > /tmp/install.sh <<'SINGULARITY_INSTALL_SH'\n"
    cat "$CLEAN_INSTALL_SH"
    printf "SINGULARITY_INSTALL_SH\n"
    printf "cat /tmp/install.sh | bash -s -- %s\n" "${CLEAN_INSTALL_ARGS:-}"
  else
    printf 'curl -fsSL %s | bash -s -- %s\n' "$INSTALL_URL" "${CLEAN_INSTALL_ARGS:-}"
  fi
}
step_02_one_command_DOC="README.md Install: \`curl -fsSL $INSTALL_URL | bash\`${CLEAN_INSTALL_SH:+ (body piped from $CLEAN_INSTALL_SH on the host, not yet on main)}${CLEAN_INSTALL_ARGS:+ With: $CLEAN_INSTALL_ARGS}."
step_02_one_command_TAG="from-docs"

step_03_new_terminal() {
  cat <<'CMD'
zsh -l -i -c 'for t in mise bun go; do printf "%-5s %s\n" "$t" "$(command -v $t || echo MISSING)"; done; command -v bun >/dev/null && cd ~/singularity && ./singularity --help >/dev/null && echo "./singularity runs"'
CMD
}
step_03_new_terminal_DOC="README.md: open a new terminal and ./singularity works there (install.sh's closing line says so)."
step_03_new_terminal_TAG="from-docs"

step_04_app_answers() {
  cat <<'CMD'
code=$(curl -sS -o /dev/null -w '%{http_code}' http://singularity.localhost:9000/)
echo "http $code"
cat ~/.singularity/worktrees/singularity/build-status.json
[ "$code" = 200 ] && grep -q '"status": *"ok"' ~/.singularity/worktrees/singularity/build-status.json
CMD
}
step_04_app_answers_DOC="README.md: the app is left at http://singularity.localhost:9000."
step_04_app_answers_TAG="from-docs"

step_05_screenshot() {
  cat <<'CMD'
zsh -l -i -c 'cd ~/singularity && ./singularity run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --out /tmp/clean-install-shot' && ls -la /tmp/clean-install-shot*
CMD
}
step_05_screenshot_DOC="README.md: the app renders, not only answers."
step_05_screenshot_TAG="from-docs"

step_06_reboot() {
  echo "sudo shutdown -r now   # run.sh reboots and waits for ssh (step_06_reboot_REBOOT=1)"
}
step_06_reboot_DOC="README.md: the app comes back by itself after a reboot."
step_06_reboot_TAG="from-docs"
step_06_reboot_REBOOT=1

step_07_app_after_reboot() {
  cat <<'CMD'
# Nothing is run by hand: only wait for what launchd brings back at login
# (gateway → Postgres → backend), up to 5 minutes.
for i in $(seq 1 100); do
  code=$(curl -sS -o /dev/null -m 5 -w '%{http_code}' http://singularity.localhost:9000/ 2>/dev/null || true)
  [ "$code" = 200 ] && { echo "http 200 after ~$((i * 3))s"; exit 0; }
  sleep 3
done
echo "http ${code:-none} — the app did not come back"
launchctl print "gui/$(id -u)/dev.singularity.gateway" 2>&1 | head -20
exit 1
CMD
}
step_07_app_after_reboot_DOC="README.md: after a reboot the app answers again with nothing re-run."
step_07_app_after_reboot_TAG="from-docs"

step_08_doctor() {
  cat <<'CMD'
zsh -l -i -c 'cd ~/singularity && mise run doctor'
CMD
}
step_08_doctor_DOC="docs/setup.md: \`mise run doctor\` says all required present; Claude Code is named as recommended until signed in."
step_08_doctor_TAG="from-docs"

STEPS=(
  step_01_baseline
  step_02_one_command
  step_03_new_terminal
  step_04_app_answers
  step_05_screenshot
  step_06_reboot
  step_07_app_after_reboot
  step_08_doctor
)
