# Guard denials, 2026-11-07 → 11-14: false-positive audit

Source: every Claude Code transcript under `~/.claude/projects` modified in the
last 7 days (~1,400 files), each `BLOCKED BY A GUARD` tool result paired with
the call it refused and the agent's next call. 540 denials.

| Guard | Denials | Verdict |
|---|---|---|
| `search-scope` (rg/fd/du outside workspace) | 205 | Mostly FP: small, bounded dirs — `~/.equin/config`, `~/.equin/logs/gateway`, `~/.equin/cache/deps/ffmpeg/<hash>`, one file via glob (`~/.cargo/registry/src/*/tauri-2.*/src/app.rs`). Real hits: `~/.claude/projects`, `~/.equin` root, `~`. Already `allowOnRepeat`, but costs a turn each. |
| `rg-replace` (`rg -r`) | 76 | Mostly TP (`rg -rn`). FP: `rg -o … -r '$1'`, a deliberate capture-group replacement. |
| `background-ops` (push/build in foreground) | 75 | TP, but the retry is always the same call with `run_in_background: true`: a corrective rewrite, not a denial. |
| `shared-tmp` | 67 | ~60% FP: `cd /tmp/...` (cd writes nothing, 27), reads passed as args (`sips`, `ffmpeg`, `lsof`, `find`), `$$`/random-suffixed names (unique by construction), Claude's own `/private/tmp/claude-501/bundled-skills`, a systemd socket path, and `promo-film`'s own `/tmp/equin-film/session` (the repo's tool picks that fixed dir — 21 denials). |
| `find` | 27 | TP by design (see guards CLAUDE.md). |
| `agent-model` | 20 | **100% FP**: all 20 were `subagent_type: "fork"`, which ignores `model`. Fixed. |
| `no-memory` | 16 | TP (policy). |
| `bun-script` | 12 | TP; rewrite already covers the common case. |
| `postgres` | 11 | TP-ish (the gateway-socket `./equin run` case is FP). |
| poll-loop | 8 | TP. |
| `main-writes` / `main-edits` | 7 | Mixed: `$EQUIN_SCRATCH` redirection read as a main write (FP). |
| others (`migrations`, `git-push`, `macos`, data-root) | 12 | TP. |

## Done in this change

- Per-call bypass for every guard (`./equin guard bypass <id> --reason …`),
  replacing the `.allow-*` files and the "BYPASS ACTIVE" chip.
- `agent-model` lets `fork` through.

## Follow-ups (not done)

- `shared-tmp`: `cd` is not a write; argv operands of read-only commands are not writes; `$$`/`mktemp`-shaped names; Claude's own `/private/tmp/claude-*`; `promo-film`'s `/tmp/equin-film/session` should move to the session scratch.
- `background-ops`: rewrite to `run_in_background: true` instead of denying.
- `search-scope`: allow known-small data dirs (`~/.equin/config`, `~/.equin/logs/<one>`, `~/.equin/cache/deps/<dep>`), and a glob that names files.
- `rg-replace`: allow `-r` when `-o` is present and the value holds `$N`.
