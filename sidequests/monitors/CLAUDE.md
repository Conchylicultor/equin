# Monitors — host-level observers that outlive the app

Standalone launchd jobs that watch the machine from **outside** equin.

Each answers a question the app cannot answer about itself: the app's own
observability dies with the process, and the failures worth chasing here are
exactly the ones that kill it, restart it, or happen while it is down.

| monitor | question | shape |
|---|---|---|
| [`fd/`](fd/CLAUDE.md) | which process is leaking file descriptors before a "too many files open" crash? | LaunchAgent, polls every 5s |

## Conventions

- **Nothing here is auto-installed.** Each monitor ships a `.plist` you load by
  hand, once — see its own `CLAUDE.md`. Deliberate: these run as background
  daemons on the user's machine, some as root.
- **The plist points at the script's path in the main checkout**
  (`/Users/epot/__A__/dev/singularity/sidequests/monitors/<name>/…`), never at a
  worktree. So a monitor only picks up an edit once it is merged to main, and a
  worktree being deleted can never take a monitor down with it.
- **Logs go to `~/.singularity/logs/monitors/<name>.log|.jsonl`**, in their own
  declared corner of the app's log kind, so one place holds every trail. (This
  subtree runs outside the build, so it can declare nothing itself — `debug`
  owns the `logs/monitors` data dir on the monitors' behalf.)
- Root monitors install to `/Library/LaunchDaemons`; user ones to
  `~/Library/LaunchAgents`.

## Adding one

Copy the shape of the nearest existing monitor — script + plist + `CLAUDE.md`
covering *why*, *what it captures*, *install*, *read it*, *uninstall*, *cost* —
and add a row to the table above.
