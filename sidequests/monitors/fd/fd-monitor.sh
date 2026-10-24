#!/bin/zsh
# FD / process snapshot for equin crash investigation.
#
# Two-tier polling. The launchd interval (default 5s) drives a *cheap probe*
# (sysctl + ps_count only, microseconds). Each probe decides whether to
# escalate to a *heavy tick* (full lsof + main-log block + incident detection):
#
#   - Scheduled: every $HEAVY_TICK_INTERVAL seconds (default 30) — baseline
#     heartbeat and trend data, runs even when nothing is unusual.
#   - Elevated: cheap probe trips a threshold
#       * num_files >= $PROBE_NUM_FILES_PCT% of kern.maxfiles
#       * ps_count >= $PROBE_PS_PCT% of kern.maxproc
#       * delta(num_files) >= $PROBE_DELTA_FILES since previous probe (rapid
#         growth — the killer signal for in-progress leaks)
#     Throttled to at most one heavy tick per $ELEVATED_MIN_GAP seconds so a
#     sustained elevation doesn't run lsof every probe.
#
# Heavy tick triggers a forensic dump to fd-monitor-incidents/<ts>/ on:
#   1. Per-pid: any single pid holds more than $SUSPECT_PID_FDS open files.
#      (Default 3000 — claude CLI normally peaks ~600; the leaker hit 65k.)
#   2. System-wide: kern.num_files crosses $SYSTEM_NUM_FILES_PCT of kern.maxfiles.
#      (Default 25% — system normally idles at ~3-5%; the crash spike hit ~80%.)
#
# Forensic dump per suspect pid:
#   - <ts>/pid<pid>.txt:    ps line, lsof type breakdown, top FD names
#   - <ts>/pid<pid>.lsof.gz: gzipped full lsof output for that pid
# Plus once per incident:
#   - <ts>/system.txt:      kernel state, top 50 cmd:pid, top 20 cmd groups
#   - <ts>/system.lsof.gz:  gzipped full system-wide lsof
#
# Self-protection: cheap probes never take the lock (silent + idempotent).
# Heavy ticks lock atomically (mkdir); contended scheduled ticks log a brief
# SKIPPED line, contended elevations silently retry on the next probe.
# Dumps have per-pid and system-wide cooldowns. lsof is sanity-checked before
# incident detection so truncated output doesn't produce garbage forensics.

LOG="$HOME/.singularity/logs/monitors/fd-monitor.log"
INCIDENTS="$HOME/.singularity/logs/monitors/fd-monitor-incidents"
MAX_LINES=200000  # rough rotation threshold for the main log

# Heavy-tick / dump thresholds.
SUSPECT_PID_FDS=${SUSPECT_PID_FDS:-3000}
SYSTEM_NUM_FILES_PCT=${SYSTEM_NUM_FILES_PCT:-25}
SYSTEM_COOLDOWN=${SYSTEM_COOLDOWN:-300}        # 5 min between system-wide dumps
PID_COOLDOWN=${PID_COOLDOWN:-300}              # 5 min between dumps for the same pid
MIN_LSOF_LINES=${MIN_LSOF_LINES:-500}          # treat lsof as failed if shorter
MAX_INCIDENT_DIRS=${MAX_INCIDENT_DIRS:-200}    # hard cap on retained incident dirs
LOCK_STALE_AFTER=${LOCK_STALE_AFTER:-90}       # seconds; lock dir older than this is stolen

# Cheap-probe escalation thresholds (lower than heavy — early warning).
HEAVY_TICK_INTERVAL=${HEAVY_TICK_INTERVAL:-30} # baseline cadence (seconds)
ELEVATED_MIN_GAP=${ELEVATED_MIN_GAP:-10}       # min gap between elevated heavy ticks
PROBE_NUM_FILES_PCT=${PROBE_NUM_FILES_PCT:-15} # heavy is 25
PROBE_DELTA_FILES=${PROBE_DELTA_FILES:-3000}   # rapid-growth abs delta
PROBE_PS_PCT=${PROBE_PS_PCT:-70}               # ps_count vs kern.maxproc

mkdir -p "$(dirname "$LOG")" "$INCIDENTS"

# --- Cheap probe (always, no lock) -------------------------------------------

now=$(date +%s)
NUM_FILES=$(sysctl -n kern.num_files 2>/dev/null || echo 0)
MAX_FILES=$(sysctl -n kern.maxfiles 2>/dev/null || echo 1)
[ "$MAX_FILES" -gt 0 ] || MAX_FILES=1
NUM_FILES_PCT=$(( NUM_FILES * 100 / MAX_FILES ))
PS_COUNT=$(ps -A 2>/dev/null | wc -l | tr -d ' ')
MAX_PROC=$(sysctl -n kern.maxproc 2>/dev/null || echo 4096)
[ "$MAX_PROC" -gt 0 ] || MAX_PROC=4096
PS_PCT=$(( PS_COUNT * 100 / MAX_PROC ))

# Track previous probe for rapid-growth detection.
LAST_PROBE="$INCIDENTS/.last-probe"
PREV_FILES=0
PREV_TS=0
if [ -f "$LAST_PROBE" ]; then
  read -r PREV_FILES PREV_TS < "$LAST_PROBE" 2>/dev/null
fi
DELTA_FILES=$(( NUM_FILES - ${PREV_FILES:-0} ))
DELTA_SECS=$(( now - ${PREV_TS:-0} ))
echo "$NUM_FILES $now" > "$LAST_PROBE"

# --- Decide whether this tick escalates to a heavy run -----------------------

LAST_HEAVY="$INCIDENTS/.last-heavy"
LAST_HEAVY_TS=0
[ -f "$LAST_HEAVY" ] && LAST_HEAVY_TS=$(stat -f %m "$LAST_HEAVY" 2>/dev/null || echo 0)
HEAVY_AGE=$(( now - LAST_HEAVY_TS ))

REASONS=()
[ "$HEAVY_AGE" -ge "$HEAVY_TICK_INTERVAL" ] && REASONS+=(scheduled)

if [ "$HEAVY_AGE" -ge "$ELEVATED_MIN_GAP" ]; then
  [ "$NUM_FILES_PCT" -ge "$PROBE_NUM_FILES_PCT" ] && REASONS+=(elevated_files)
  [ "$PS_PCT"        -ge "$PROBE_PS_PCT"        ] && REASONS+=(elevated_ps)
  # Rapid growth only meaningful when the previous probe was recent.
  if [ "$DELTA_SECS" -ge 1 ] && [ "$DELTA_SECS" -le 30 ] && [ "$DELTA_FILES" -ge "$PROBE_DELTA_FILES" ]; then
    REASONS+=(rapid_growth)
  fi
fi

[ ${#REASONS[@]} -eq 0 ] && exit 0

# --- Acquire lock for heavy tick ---------------------------------------------

LOCK="$INCIDENTS/.lock"
acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then return 0; fi
  local age=$(( now - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$age" -gt "$LOCK_STALE_AFTER" ]; then
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null && return 0
  fi
  return 1
}
if ! acquire_lock; then
  # Silent skip unless a scheduled tick was the reason — that means heavy work
  # is taking longer than HEAVY_TICK_INTERVAL, which is worth flagging.
  case " ${REASONS[*]} " in
    *" scheduled "*)
      echo "===== $(date '+%Y-%m-%d %H:%M:%S') SKIPPED — heavy tick contended =====" >> "$LOG"
      ;;
  esac
  exit 0
fi
trap 'rm -rf "$LOCK"' EXIT INT TERM

# --- Heavy tick: lsof + main log block ---------------------------------------

# Annotate when escalation is the reason (so reading the log shows *why* this
# block exists outside the scheduled cadence).
case " ${REASONS[*]} " in
  *" scheduled "*) ;;
  *)
    echo "----- $(date '+%Y-%m-%d %H:%M:%S') ESCALATED reasons=${REASONS[*]} num_files_pct=$NUM_FILES_PCT delta_files=$DELTA_FILES ps_pct=$PS_PCT -----" >> "$LOG"
    ;;
esac

LSOF_TMP=$(mktemp -t fd-monitor-lsof)
lsof -n -P 2>/dev/null > "$LSOF_TMP"
LSOF_TOTAL=$(wc -l < "$LSOF_TMP" | tr -d ' ')

# top holders: "<count> <cmd>:<pid>" sorted desc
HOLDERS=$(awk 'NR>1 {print $1":"$2}' "$LSOF_TMP" | sort | uniq -c | sort -rn)

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') ====="
  sysctl kern.num_files kern.maxfiles kern.maxproc kern.maxfilesperproc 2>/dev/null
  echo "ps_count=$PS_COUNT"
  echo "lsof_total=$LSOF_TOTAL"
  echo "num_files_pct=$NUM_FILES_PCT"

  echo "--- top 20 FD holders (count cmd:pid) ---"
  printf '%s\n' "$HOLDERS" | head -20

  echo "--- top 10 FD-holding command groups ---"
  awk 'NR>1 {print $1}' "$LSOF_TMP" | sort | uniq -c | sort -rn | head -10

  echo "--- singularity quick stats ---"
  GATEWAY_PID=$(pgrep -x gateway 2>/dev/null)
  echo "gateway_pid=${GATEWAY_PID:-none}"
  if [ -n "$GATEWAY_PID" ]; then
    echo "gateway_fds=$(awk -v p="$GATEWAY_PID" '$2==p' "$LSOF_TMP" | wc -l | tr -d ' ')"
  fi
  echo "bun_backends=$(pgrep -f 'bun src/index.ts' 2>/dev/null | wc -l | tr -d ' ')"
  echo "tmux_sessions=$(/opt/homebrew/bin/tmux list-sessions 2>/dev/null | wc -l | tr -d ' ')"
  echo "claude_cli_procs=$(pgrep -af '/claude($| )' 2>/dev/null | wc -l | tr -d ' ')"
  echo "postgres_backends=$(ps -axo user,command 2>/dev/null | grep -E '^admin +postgres:' | wc -l | tr -d ' ')"
  echo "worktree_jsons=$(ls "$HOME/.singularity/worktrees/"*.json 2>/dev/null | wc -l | tr -d ' ')"
  echo
} >> "$LOG" 2>&1

# --- Sanity-gate incident detection ------------------------------------------
# If lsof returned almost nothing, it failed (or the system is under FD pressure
# severe enough that lsof itself couldn't enumerate). Skip incident dumps —
# writing forensics off truncated data is worse than writing none.

if [ "$LSOF_TOTAL" -lt "$MIN_LSOF_LINES" ]; then
  echo "!!!!! lsof returned only $LSOF_TOTAL lines (< $MIN_LSOF_LINES) — skipping incident detection" >> "$LOG"
  rm -f "$LSOF_TMP"
else

# --- Incident detection ------------------------------------------------------

# Suspect pids: any holder above the per-pid threshold.
SUSPECT_PIDS=$(printf '%s\n' "$HOLDERS" | awk -v t="$SUSPECT_PID_FDS" '
  $1+0 > t+0 {
    n = split($2, a, ":");
    print a[n];   # last segment is pid (cmd may contain colons)
  }')

SYSTEM_INCIDENT=0
[ "$NUM_FILES_PCT" -ge "$SYSTEM_NUM_FILES_PCT" ] && SYSTEM_INCIDENT=1

sentinel_age() {
  local f="$1"
  [ -f "$f" ] || { echo 99999999; return; }
  echo $(( now - $(stat -f %m "$f" 2>/dev/null || echo 0) ))
}

if [ -n "$SUSPECT_PIDS" ] || [ "$SYSTEM_INCIDENT" = 1 ]; then
  TS=$(date '+%Y%m%d-%H%M%S')
  DIR="$INCIDENTS/$TS"

  # Decide which dumps to write based on cooldowns.
  WRITE_SYSTEM=0
  if [ "$SYSTEM_INCIDENT" = 1 ]; then
    AGE=$(sentinel_age "$INCIDENTS/.last-system")
    [ "$AGE" -ge "$SYSTEM_COOLDOWN" ] && WRITE_SYSTEM=1
  fi
  PIDS_TO_DUMP=()
  PIDS_THROTTLED=()
  for pid in ${=SUSPECT_PIDS}; do
    AGE=$(sentinel_age "$INCIDENTS/.last-pid-$pid")
    if [ "$AGE" -ge "$PID_COOLDOWN" ]; then
      PIDS_TO_DUMP+=("$pid")
    else
      PIDS_THROTTLED+=("$pid")
    fi
  done

  SUSPECT_PIDS_INLINE=$(printf '%s' "$SUSPECT_PIDS" | tr '\n' ' ' | sed 's/ *$//')
  {
    echo "!!!!! INCIDENT $TS  num_files_pct=$NUM_FILES_PCT  suspect_pids=${SUSPECT_PIDS_INLINE:-none}"
    if [ "$WRITE_SYSTEM" = 1 ] || [ ${#PIDS_TO_DUMP[@]} -gt 0 ]; then
      echo "!!!!! dumping: system=$WRITE_SYSTEM  pids=${PIDS_TO_DUMP[*]:-none}  throttled_pids=${PIDS_THROTTLED[*]:-none}"
      echo "!!!!! see: $DIR/"
    else
      echo "!!!!! all dumps throttled (cooldowns active); throttled_pids=${PIDS_THROTTLED[*]:-none}"
    fi
  } >> "$LOG"

  # Only create the dir if we're actually going to write something into it.
  if [ "$WRITE_SYSTEM" = 1 ] || [ ${#PIDS_TO_DUMP[@]} -gt 0 ]; then
    mkdir -p "$DIR"

    if [ "$WRITE_SYSTEM" = 1 ]; then
      {
        echo "===== INCIDENT $TS — system snapshot ====="
        sysctl kern.num_files kern.maxfiles kern.maxproc kern.maxfilesperproc 2>/dev/null
        echo "lsof_total=$LSOF_TOTAL"
        echo "num_files_pct=$NUM_FILES_PCT  threshold=$SYSTEM_NUM_FILES_PCT"
        echo
        echo "--- top 50 FD holders (count cmd:pid) ---"
        printf '%s\n' "$HOLDERS" | head -50
        echo
        echo "--- top 20 FD-holding command groups ---"
        awk 'NR>1 {print $1}' "$LSOF_TMP" | sort | uniq -c | sort -rn | head -20
        echo
        echo "--- ps -A (full) ---"
        ps -axww -o pid,ppid,user,etime,rss,command 2>/dev/null
      } > "$DIR/system.txt"
      gzip -c "$LSOF_TMP" > "$DIR/system.lsof.gz"
      touch "$INCIDENTS/.last-system"
    fi

    for pid in "${PIDS_TO_DUMP[@]}"; do
      {
        echo "===== INCIDENT $TS — pid=$pid ====="
        echo "--- ps -ww ---"
        ps -ww -p "$pid" -o pid,ppid,user,etime,rss,vsz,command 2>/dev/null
        echo
        echo "--- lsof type breakdown ---"
        awk -v p="$pid" '$2==p {print $5}' "$LSOF_TMP" | sort | uniq -c | sort -rn
        echo
        echo "--- lsof FD-kind (column 4) breakdown ---"
        awk -v p="$pid" '$2==p {print $4}' "$LSOF_TMP" | sort | uniq -c | sort -rn | head -30
        echo
        echo "--- top 30 FD names ---"
        awk -v p="$pid" '$2==p {print $NF}' "$LSOF_TMP" | sort | uniq -c | sort -rn | head -30
        echo
        echo "--- sample 30 lines of full lsof for this pid ---"
        awk -v p="$pid" '$2==p' "$LSOF_TMP" | head -30
      } > "$DIR/pid$pid.txt"
      awk -v p="$pid" '$2==p' "$LSOF_TMP" | gzip > "$DIR/pid$pid.lsof.gz"
      touch "$INCIDENTS/.last-pid-$pid"
    done
  fi
fi

rm -f "$LSOF_TMP"
fi  # end LSOF_TOTAL sanity guard

# Mark heavy tick complete (mtime drives next-tick scheduling decisions).
touch "$LAST_HEAVY"

# --- Lazy rotation of main log -----------------------------------------------

if [ -f "$LOG" ]; then
  LINES=$(wc -l < "$LOG" 2>/dev/null | tr -d ' ')
  if [ "${LINES:-0}" -gt "$MAX_LINES" ]; then
    mv "$LOG" "$LOG.1"
  fi
fi

# --- Incident-dir housekeeping -----------------------------------------------

# Time-based: drop dirs older than 14 days.
find "$INCIDENTS" -mindepth 1 -maxdepth 1 -type d -not -name '.*' -mtime +14 -exec rm -rf {} + 2>/dev/null

# Hard cap: if too many remain, drop the oldest by name (timestamps sort naturally).
DIRS_LIST=$(find "$INCIDENTS" -mindepth 1 -maxdepth 1 -type d -not -name '.*' 2>/dev/null | sort)
DIR_COUNT=$(printf '%s\n' "$DIRS_LIST" | grep -c '^.' )
if [ "${DIR_COUNT:-0}" -gt "$MAX_INCIDENT_DIRS" ]; then
  EXCESS=$(( DIR_COUNT - MAX_INCIDENT_DIRS ))
  printf '%s\n' "$DIRS_LIST" | head -n "$EXCESS" | xargs rm -rf 2>/dev/null
fi
