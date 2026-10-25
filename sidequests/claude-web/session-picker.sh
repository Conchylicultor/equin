#!/bin/bash
# session-picker.sh — List and reattach to existing Claude tmux sessions
#
# Bookmark: localhost:8103 (picker menu)
#           localhost:8102 (new session, via --new flag)
# Shows existing sessions with arrow-key navigation, or creates a new one.
# Pass --new to skip the menu and immediately create a fresh session.

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFIX="claude"
TMUX="/opt/homebrew/bin/tmux"
CLAUDE="/Users/epot/.local/bin/claude"
GIT=/usr/bin/git
WORKTREE_DIR="$WORKDIR/.claude/worktrees"

create_new() {
  local name="${PREFIX}-$(date +%s)"
  local branch="claude-web/$name"
  local wt_path="$WORKTREE_DIR/$name"

  # Create a new worktree with a fresh branch off main
  $GIT -C "$WORKDIR" worktree add -b "$branch" "$wt_path" main 2>/dev/null

  # Fork the base DB so ./equin build works without the server.
  # Only drop if the DB already exists but the fork is incomplete (interrupted
  # mid pg_restore); a fresh name won't exist at all so createdb runs clean.
  if ! psql -d "$name" -tAc "SELECT 1 FROM __singularity_migrations LIMIT 1" 2>/dev/null | grep -q 1; then
    if psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$name"; then
      psql -c "DROP DATABASE \"$name\""
    fi
    createdb "$name"
    pg_dump -Fc singularity | pg_restore -d "$name"
  fi

  $TMUX -u new-session -d -s "$name" -c "$wt_path" \
    "zsh -l -c 'export EQUIN_CONVERSATION_ID=$name SINGULARITY_CONVERSATION_ID=$name; export EQUIN_PARENT_HOST=singularity SINGULARITY_PARENT_HOST=singularity; $CLAUDE'"
  exec $TMUX -u attach -t "$name"
}

resume_session() {
  local query="$1"
  local name="${PREFIX}-$(date +%s)"
  $TMUX -u new-session -d -s "$name" -c "$WORKDIR" "zsh -l -c '$CLAUDE --resume \"$query\"'"
  exec $TMUX -u attach -t "$name"
}

[[ "$1" == "--new" ]] && create_new

# Collect existing sessions
existing=$($TMUX list-sessions -F "#{session_created} #{session_name}" 2>/dev/null | sort -rn | awk '{print $2}')

# No existing sessions — go straight to new
if [[ -z "$existing" ]]; then
  echo "  No existing sessions. Starting a new one..."
  sleep 1
  create_new
fi

# Build session list
declare -a names
declare -a labels
i=0

# "New session" is always first
names[$i]="__new__"
labels[$i]="+ New session"
((i++))

while IFS= read -r s; do
  created=$($TMUX display-message -t "$s" -p "#{t:session_created}" 2>/dev/null)
  title=$($TMUX display-message -t "$s" -p "#{pane_title}" 2>/dev/null)
  # Strip leading "_ " prefix that Claude Code sets in pane title
  title="${title#_ }"
  names[$i]="$s"
  label="[$created] ${title:-$s}"
  labels[$i]="$label"
  ((i++))
done <<< "$existing"

names[$i]="__resume__"
labels[$i]="↩ Resume session (enter id or name)"
((i++))

total=${#names[@]}
selected=0

# Hide cursor, handle cleanup
tput civis 2>/dev/null
cleanup() { tput cnorm 2>/dev/null; }
trap cleanup EXIT

draw() {
  clear
  echo ""
  echo "  Claude Code Sessions"
  echo "  ===================="
  echo "  (↑/↓ to navigate, Enter to select, q to quit)"
  echo ""

  for j in $(seq 0 $((total - 1))); do
    if [[ $j -eq $selected ]]; then
      echo "  → ${labels[$j]}"
    else
      echo "    ${labels[$j]}"
    fi
  done
}

draw

while true; do
  # Read a single keypress
  IFS= read -rsn1 key

  case "$key" in
    $'\x1b')
      # Read escape sequence byte by byte for ttyd compatibility
      read -rsn1 -t 1 seq1
      read -rsn1 -t 1 seq2
      case "${seq1}${seq2}" in
        '[A'|'OA') # Up arrow
          ((selected--))
          [[ $selected -lt 0 ]] && selected=$((total - 1))
          ;;
        '[B'|'OB') # Down arrow
          ((selected++))
          [[ $selected -ge $total ]] && selected=0
          ;;
      esac
      ;;
    '') # Enter
      chosen="${names[$selected]}"
      if [[ "$chosen" == "__new__" ]]; then
        create_new
      elif [[ "$chosen" == "__resume__" ]]; then
        tput cnorm 2>/dev/null
        echo ""
        echo ""
        read -rp "  Session id or name: " query
        if [[ -n "$query" ]]; then
          resume_session "$query"
        fi
      else
        exec $TMUX -u attach -t "$chosen"
      fi
      ;;
    'q'|'Q')
      exit 0
      ;;
    [0-9])
      # Direct number selection (1-indexed for sessions)
      idx=$((key))
      if [[ $idx -ge 0 && $idx -lt $total ]]; then
        selected=$idx
      fi
      ;;
  esac

  draw
done
