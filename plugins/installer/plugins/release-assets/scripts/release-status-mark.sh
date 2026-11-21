#!/usr/bin/env bash
# release-status: the Release says whether its window is attached.
# - attached: any earlier "not attached" note is taken off the notes;
# - not attached: the notes say so (with this run's link), the run fails with
#   an error naming the job, and `retry=true` is output when every build job
#   that did not succeed never got a runner (and this run is not a retry).
#
# Env: TAG, ATTACH (the attach job's result), RETRIED (the dispatch input;
# empty on a push), RUN_URL, GH_REPO, GH_TOKEN.
# Output: retry.
set -euo pipefail
BEGIN="<!-- installer-window-status -->"
END="<!-- /installer-window-status -->"
body="$(gh release view "$TAG" --json body --jq .body | tr -d '\r')"
# The notes without any earlier status block.
base="$(printf '%s\n' "$body" | awk -v b="$BEGIN" -v e="$END" '
  $0 == b { skip = 1; next } $0 == e { skip = 0; next } !skip')"
if [ "$ATTACH" = success ]; then
  if [ "$base" != "$body" ]; then
    printf '%s\n' "$base" | gh release edit "$TAG" --notes-file -
    echo "::notice::$TAG: the installer window is attached; the 'not attached' note is removed."
  fi
  exit 0
fi
# Which build jobs did not succeed, and which of them GitHub never
# gave a runner — said by the job's own annotation, not guessed from
# its empty step list (a job cancelled by hand while queued has none
# either).
jobs="$(gh api --paginate "repos/$GH_REPO/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs" \
  --jq '.jobs[] | select(.name | test("^(Installer page|macOS|Linux)")) | select(.conclusion != "success" and .conclusion != "skipped") | "\(.id)\t\(.name)\t\(.conclusion)"')"
failed="" unacquired=0 other=0
while IFS=$'\t' read -r id name conclusion; do
  [ -n "$id" ] || continue
  failed="${failed:+$failed, }$name ($conclusion)"
  msgs="$(gh api "repos/$GH_REPO/check-runs/$id/annotations" --jq '.[].message')"
  if grep -q 'not acquired by Runner' <<< "$msgs"; then
    unacquired=$((unacquired + 1))
  else
    other=$((other + 1))
  fi
done <<< "$jobs"
retry=false
if [ "${RETRIED:-false}" != true ] && [ "$unacquired" -gt 0 ] && [ "$other" -eq 0 ]; then retry=true; fi
next="Re-attach it: \`gh workflow run installer-release.yml -R $GH_REPO -f ref=$TAG -f window=true\`."
if [ "$retry" = true ]; then next="A build never got a GitHub runner, so the attach is re-run once automatically."; fi
{
  printf '%s\n\n' "$base"
  echo "$BEGIN"
  echo "> [!WARNING]"
  echo "> The installer window is not attached to this release (${failed:-attach: $ATTACH}; [run]($RUN_URL))."
  echo "> \`curl | bash\` installs it in the terminal; \`--window\` stops. $next"
  echo "$END"
} | gh release edit "$TAG" --notes-file -
echo "retry=$retry" >> "$GITHUB_OUTPUT"
echo "::error::$TAG was published WITHOUT its installer window: ${failed:-attach $ATTACH}. $next"
exit 1
